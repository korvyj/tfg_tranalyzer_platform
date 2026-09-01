"""Panel de estado de las sondas (FastAPI).

Combina dos fuentes:
  - salt-api  -> qué sondas están online y si están capturando.
  - MongoDB   -> nº de flujos y último flujo por sonda.

Rutas:
  GET  /                        tabla HTML de la flota (auto-refresco).
  GET  /api/status              mismo contenido en JSON.
  GET  /sonda/<id>              detalle HTML de una sonda.
  GET  /api/sonda/<id>          detalle en JSON (métricas, resumen, flujos).
       …/ip · …/timeseries · …/flow/<fid> · …/export   consultas del detalle.
  POST …/action · …/config · …/clear                   control de la sonda.

Ninguna ruta devuelve 500 si Salt o Mongo fallan: el error viaja en el cuerpo.
"""
from __future__ import annotations

import asyncio
import csv
import io
import os
import re
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from .mongo_client import MongoStats
from .salt_client import SaltClient

BASE = Path(__file__).resolve().parent
app = FastAPI(title="Panel de sondas TFG")
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
templates = Jinja2Templates(directory=BASE / "templates")

salt = SaltClient()
mongo = MongoStats()


def _sid_to_collection(sonda_id: str) -> str:
    return "flow_" + sonda_id.replace("-", "_")


# Formato válido de id de sonda (evita inyección al construir la colección/target
# Salt): p. ej. 'sonda-1'. Solo letras, dígitos, guion y guion bajo.
_SID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

# IP válida (IPv4 o IPv6): solo dígitos hex, puntos y dos puntos. Filtra la
# entrada del buscador de IP antes de llegar a Mongo.
_IP_RE = re.compile(r"^[0-9a-fA-F:.]{2,45}$")

# ObjectId de Mongo (24 hex): valida el id de flujo antes de consultarlo.
_OID_RE = re.compile(r"^[0-9a-fA-F]{24}$")

# Acciones del catálogo Salt que el panel puede lanzar. 'set_interface' recibe
# un argumento (la interfaz); el resto no reciben argumentos.
_ACTIONS = {
    "start": "tranalyzer.start",
    "stop": "tranalyzer.stop",
    "restart": "tranalyzer.restart",
    "apply_config": "tranalyzer.apply_config",
    "set_interface": "tranalyzer.set_interface",
}


def _bad_request(msg: str, *, key: str = "error", ok: bool = False) -> JSONResponse:
    """Respuesta 400 con la forma que espera el panel para cada tipo de ruta:
    {'error': …} en las de lectura, {'_error': …} en el detalle de flujo y
    {'ok': false, 'error': …} en las de acción."""
    body = {key: msg}
    if ok:
        body = {"ok": False, **body}
    return JSONResponse(body, status_code=400)


def _invalid_sid(sonda_id: str, **kw) -> JSONResponse | None:
    """Devuelve la respuesta de error si el id de sonda no es válido, o None."""
    if _SID_RE.match(sonda_id):
        return None
    return _bad_request("id de sonda no válido", **kw)


def _salt_response(result: dict) -> JSONResponse:
    """502 si la acción Salt falló; 200 si se ejecutó."""
    return JSONResponse(result, status_code=200 if result.get("ok") else 502)


async def build_status() -> dict:
    salt_status = await salt.sonda_status()
    mongo_status = mongo.per_sonda()
    salt_err = salt_status.pop("_error", None)
    mongo_err = mongo_status.pop("_error", None)

    # Unión de sondas conocidas por Salt y por colecciones de Mongo
    ids = set(salt_status.keys())
    coll_by_id = {}
    for coll in mongo_status:
        # flow_sonda_1 -> sonda-1 (per_sonda solo devuelve colecciones 'flow_<id>')
        sid = coll[len("flow_"):].replace("_", "-")
        coll_by_id[sid] = coll
        ids.add(sid)

    now = time.time()
    sondas = []
    for sid in sorted(ids):
        s = salt_status.get(sid, {})
        coll = coll_by_id.get(sid, _sid_to_collection(sid))
        m = mongo_status.get(coll, {})
        last_ts = m.get("last_ts")
        sondas.append({
            "id": sid,
            "online": bool(s.get("online", False)),
            "capturing": bool(s.get("capturing", False)),
            "collection": coll,
            "flows": m.get("flows", 0),
            "flows_5m": m.get("flows_5m", 0),
            "last_ts": last_ts,
            "last_seen_s": round(now - last_ts) if last_ts else None,
        })

    return {
        "generated_at": now,
        "sondas": sondas,
        "errors": {"salt": salt_err, "mongo": mongo_err},
    }


@app.get("/api/status")
async def api_status() -> JSONResponse:
    return JSONResponse(await build_status())


@app.get("/")
async def index(request: Request):
    data = await build_status()
    return templates.TemplateResponse(request, "index.html", {"data": data})


# Ventanas de tiempo permitidas para la métrica "últimos X" (segundos).
_WINDOWS = {60, 300, 900, 3600}

# Claves de configuración editables desde el panel y su validador. Deben
# coincidir con ALLOWED_KEYS del módulo de ejecución 'tranalyzer'.
_CONFIG_FIELDS = {
    "IFACE": re.compile(r"^[A-Za-z0-9._-]+$"),
    "MONGO_HOST": re.compile(r"^[A-Za-z0-9._-]+$"),
    "MONGO_PORT": re.compile(r"^\d{1,5}$"),
    "MONGO_DBNAME": re.compile(r"^[A-Za-z0-9._-]+$"),
    "MONGO_TABLE_NAME": re.compile(r"^[A-Za-z0-9._-]+$"),
}


async def build_sonda_detail(sonda_id: str, window_s: int = 300) -> dict:
    """Combina el estado Salt de una sonda con las métricas de su colección Mongo."""
    coll = _sid_to_collection(sonda_id)
    detail = mongo.sonda_detail(coll, window_s=window_s)
    mongo_err = detail.pop("_error", None)

    # Las dos consultas a Salt son independientes: se lanzan a la vez.
    salt_status, info = await asyncio.gather(
        salt.sonda_status(), salt.sonda_info(sonda_id)
    )
    salt_err = salt_status.pop("_error", None)
    s = salt_status.get(sonda_id, {})
    info_err = info.pop("_error", None) if isinstance(info, dict) else None

    now = time.time()
    last_ts = detail.get("last_ts")
    return {
        "generated_at": now,
        "id": sonda_id,
        "collection": coll,
        "online": bool(s.get("online", False)),
        "capturing": bool(s.get("capturing", False)),
        "last_seen_s": round(now - last_ts) if last_ts else None,
        "info": info if not info_err else {},
        **detail,
        "errors": {"salt": salt_err, "mongo": mongo_err, "info": info_err},
    }


def _parse_window(request: Request) -> int:
    try:
        w = int(request.query_params.get("window", "300"))
    except (TypeError, ValueError):
        return 300
    return w if w in _WINDOWS else 300


@app.get("/api/sonda/{sonda_id}")
async def api_sonda(sonda_id: str, request: Request) -> JSONResponse:
    if err := _invalid_sid(sonda_id):
        return err
    return JSONResponse(await build_sonda_detail(sonda_id, _parse_window(request)))


@app.get("/api/sonda/{sonda_id}/ip")
async def api_sonda_ip(sonda_id: str, request: Request) -> JSONResponse:
    """Perfil de una IP dentro de la colección de la sonda (protocolos, países,
    organizaciones y pares con los que ha hablado)."""
    if err := _invalid_sid(sonda_id):
        return err
    ip = (request.query_params.get("ip") or "").strip()
    if not _IP_RE.match(ip):
        return _bad_request("IP no válida")
    return JSONResponse(mongo.ip_detail(_sid_to_collection(sonda_id), ip))


_TS_BY = {"total", "protocol", "country", "l4"}


@app.get("/api/sonda/{sonda_id}/timeseries")
async def api_sonda_timeseries(sonda_id: str, request: Request) -> JSONResponse:
    """Serie temporal de flujos (para la gráfica de evolución)."""
    if err := _invalid_sid(sonda_id):
        return err
    window = _parse_window(request)
    by = (request.query_params.get("by") or "total").lower()
    if by not in _TS_BY:
        by = "total"
    try:
        buckets = int(request.query_params.get("buckets", "30"))
    except (TypeError, ValueError):
        buckets = 30
    buckets = max(10, min(60, buckets))
    return JSONResponse(
        mongo.timeseries(_sid_to_collection(sonda_id), window_s=window, buckets=buckets, by=by)
    )


@app.get("/api/sonda/{sonda_id}/flow/{flow_id}")
async def api_sonda_flow(sonda_id: str, flow_id: str) -> JSONResponse:
    """Documento completo de un flujo (todos los campos de Tranalyzer)."""
    if err := _invalid_sid(sonda_id, key="_error"):
        return err
    if not _OID_RE.match(flow_id):
        return _bad_request("id de flujo no válido", key="_error")
    return JSONResponse(mongo.flow_detail(_sid_to_collection(sonda_id), flow_id))


@app.get("/api/sonda/{sonda_id}/export")
async def api_sonda_export(sonda_id: str, request: Request):
    """Exporta los últimos flujos de la sonda como CSV o JSON (descarga)."""
    if err := _invalid_sid(sonda_id):
        return err
    fmt = (request.query_params.get("format") or "json").lower()
    if fmt not in ("json", "csv"):
        return _bad_request("formato no válido (json|csv)")

    rows = mongo.export_flows(_sid_to_collection(sonda_id))
    fields = mongo.EXPORT_FIELDS

    if fmt == "json":
        return JSONResponse(rows, headers={
            "Content-Disposition": f'attachment; filename="{sonda_id}_flujos.json"'
        })

    def gen_csv():
        # DictWriter escribe en un buffer que se vacía tras enviar cada fila.
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=fields, extrasaction="ignore")

        def flush() -> str:
            data = buf.getvalue()
            buf.seek(0)
            buf.truncate(0)
            return data

        writer.writeheader()
        yield flush()
        for r in rows:
            writer.writerow(r)
            yield flush()

    return StreamingResponse(gen_csv(), media_type="text/csv; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="{sonda_id}_flujos.csv"'
    })


@app.get("/sonda/{sonda_id}")
async def sonda_page(request: Request, sonda_id: str):
    if err := _invalid_sid(sonda_id):
        return err
    data = await build_sonda_detail(sonda_id, _parse_window(request))
    return templates.TemplateResponse(request, "sonda.html", {"data": data})


@app.post("/api/sonda/{sonda_id}/action")
async def api_sonda_action(sonda_id: str, request: Request) -> JSONResponse:
    """Lanza una acción del catálogo Salt sobre la sonda (start/stop/restart/…)."""
    if err := _invalid_sid(sonda_id, ok=True):
        return err
    try:
        body = await request.json()
    except Exception:
        body = {}
    action = body.get("action")
    fun = _ACTIONS.get(action)
    if not fun:
        return _bad_request("acción no permitida", ok=True)

    arg = None
    if action == "set_interface":
        arg = (body.get("iface") or "").strip()
        # Nombre de interfaz razonable (eth0, wlan0, enp3s0…): evita inyectar shell.
        if not _CONFIG_FIELDS["IFACE"].match(arg):
            return _bad_request("nombre de interfaz no válido", ok=True)

    return _salt_response(await salt.run_action(sonda_id, fun, arg))


@app.post("/api/sonda/{sonda_id}/config")
async def api_sonda_config(sonda_id: str, request: Request) -> JSONResponse:
    """Edita la configuración de la sonda (sonda.env) y reinicia la captura."""
    if err := _invalid_sid(sonda_id, ok=True):
        return err
    try:
        body = await request.json()
    except Exception:
        body = {}
    incoming = body.get("config") or {}
    if not isinstance(incoming, dict):
        return _bad_request("config inválida", ok=True)

    cfg = {}
    for key, val in incoming.items():
        rx = _CONFIG_FIELDS.get(key)
        if rx is None:
            return _bad_request(f"clave no permitida: {key}", ok=True)
        val = str(val).strip()
        if not rx.match(val):
            return _bad_request(f"valor no válido para {key}", ok=True)
        cfg[key] = val
    if not cfg:
        return _bad_request("sin cambios", ok=True)

    return _salt_response(await salt.run_action(sonda_id, "tranalyzer.set_config", kwargs=cfg))


@app.post("/api/sonda/{sonda_id}/clear")
async def api_sonda_clear(sonda_id: str) -> JSONResponse:
    """Vacía la colección de flujos de la sonda (limpia los datos en MongoDB)."""
    if err := _invalid_sid(sonda_id, ok=True):
        return err
    return _salt_response(mongo.clear_collection(_sid_to_collection(sonda_id)))


def run() -> None:
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("DASH_PORT", "8000")))


if __name__ == "__main__":
    run()
