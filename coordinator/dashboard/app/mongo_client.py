"""Consultas a MongoDB para el panel: métricas de flujos por sonda.

Convención: cada sonda escribe en su propia colección 'flow_<id>'. El panel
recorre esas colecciones y agrega por sonda.
"""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone

from bson import ObjectId
from bson.errors import InvalidId
from pymongo import MongoClient


def _to_epoch(value) -> float | None:
    """Normaliza 'timeLast' a epoch en segundos.

    mongoSink escribe 'timeLast' como fecha BSON (datetime), pero también se
    admite un valor numérico (epoch) por si cambia el formato de salida.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.timestamp()
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _split_ndpi(value):
    """Separa 'nDPIclass' en (protocolo, servicio).

    nDPI da 'master.subprotocolo' (p. ej. 'TLS.Wikipedia'): el protocolo es la
    parte antes del punto y el servicio (derivado del SNI/host) la de después.
    Sin subprotocolo, el servicio es None.
    """
    if not value:
        return (None, None)
    if "." in value:
        proto, service = value.split(".", 1)
        return (proto, service)
    return (value, None)


def _clean_org(value):
    """Normaliza 'dstIPOrg' de geoip; descarta entradas técnicas/desconocidas."""
    if not value:
        return None
    v = str(value).strip()
    if not v or v in ("-", "--") or v.startswith("!"):
        return None
    return v


# Nombres de protocolo de capa 4 (l4Proto es el número IANA, no un nombre).
_PROTO_NAMES = {1: "ICMP", 2: "IGMP", 6: "TCP", 17: "UDP", 58: "ICMPv6"}


def _threshold(sample, epoch: float):
    """Umbral temporal en el mismo tipo que el valor almacenado.

    mongoSink escribe fechas BSON, pero se admite epoch numérico por si cambia
    el formato de salida: la comparación debe usar el mismo tipo que 'sample'.
    """
    if isinstance(sample, datetime):
        return datetime.fromtimestamp(epoch, tz=timezone.utc)
    return epoch


def _safe(fn, default):
    """Ejecuta una consulta y devuelve 'default' si Mongo falla."""
    try:
        return fn()
    except Exception:
        return default


class MongoStats:
    def __init__(self) -> None:
        uri = os.environ.get("MONGO_URI", "mongodb://10.0.0.1:27017")
        dbname = os.environ.get("MONGO_DBNAME", "tranalyzer")
        # serverSelectionTimeoutMS bajo para que el panel no se bloquee si Mongo cae
        self._client = MongoClient(uri, serverSelectionTimeoutMS=3000)
        self._db = self._client[dbname]

    def _open(self, collection: str):
        """Devuelve (colección, error). La colección es None si no existe todavía
        (sonda que aún no ha exportado flujos: no es un error) o si Mongo falla."""
        try:
            if collection not in set(self._db.list_collection_names()):
                return None, None
        except Exception as exc:
            return None, str(exc)
        return self._db[collection], None

    @staticmethod
    def _top(col, field: str, limit: int = 8, match: dict | None = None) -> list:
        """Top-N valores de un campo por número de flujos."""
        pipeline = [{"$match": match or {}},
                    {"$group": {"_id": "$" + field, "n": {"$sum": 1}}},
                    {"$sort": {"n": -1}},
                    {"$limit": limit}]
        return _safe(lambda: [{"value": d["_id"], "count": d["n"]}
                              for d in col.aggregate(pipeline)
                              if d["_id"] not in (None, "")], [])

    def per_sonda(self) -> dict[str, dict]:
        """Devuelve {coleccion: {flows, flows_5m, last_ts}} por cada 'flow*'."""
        try:
            # Solo 'flow_<id>' identifica una sonda; una colección 'flow' suelta no.
            names = [c for c in self._db.list_collection_names() if c.startswith("flow_")]
        except Exception as exc:
            return {"_error": str(exc)}

        now = time.time()
        out: dict[str, dict] = {}
        for name in names:
            col = self._db[name]
            # mongoSink escribe 'timeLast' como fecha BSON (datetime).
            last_doc = _safe(
                lambda: col.find_one(sort=[("timeLast", -1)], projection={"timeLast": 1}), None)
            raw_last = last_doc.get("timeLast") if last_doc else None
            flows_5m = 0 if raw_last is None else _safe(
                lambda: col.count_documents(
                    {"timeLast": {"$gte": _threshold(raw_last, now - 300)}}), 0)
            out[name] = {
                "flows": _safe(col.estimated_document_count, 0),
                "flows_5m": flows_5m,
                "last_ts": _to_epoch(raw_last),
            }
        return out

    def sonda_detail(self, collection: str, window_s: int = 300, recent: int = 100) -> dict:
        """Métricas detalladas de una sonda a partir de su colección 'flow_<id>'.

        Agrega los flujos por clasificación de nDPI, país y organización de
        destino (GeoIP) y clase de puerto/servicio; añade totales, los flujos de
        la ventana 'window_s' (configurable desde el panel) y una tabla con los
        últimos flujos. Si la colección no existe o Mongo falla, devuelve
        '_error' y el resto de campos vacíos (el panel nunca da 500).
        """
        empty = {
            "flows": 0,
            "flows_window": 0,
            "window_s": window_s,
            "last_ts": None,
            "first_ts": None,
            "summary": {"unique_ips": 0, "countries": 0, "protocols": 0, "orgs": 0},
            "ndpi": [],
            "countries": [],
            "orgs": [],
            "ports": [],
            "recent": [],
        }
        col, error = self._open(collection)
        if error:
            return {**empty, "_error": error}
        if col is None:
            # Sonda sin colección todavía (aún no ha exportado flujos): no es error.
            return empty

        now = time.time()

        def top(field: str, exclude: list | None = None) -> list:
            return self._top(col, field,
                             match={field: {"$nin": exclude}} if exclude else None)

        def distinct_count(pipeline: list) -> int:
            """Nº de valores distintos que produce un pipeline terminado en $count."""
            r = _safe(lambda: list(col.aggregate(pipeline)), [])
            return r[0]["n"] if r else 0

        total = _safe(col.estimated_document_count, 0)

        # Tarjetas resumen: recuentos de valores distintos (IPs de destino,
        # países, protocolos L7 maestros y organizaciones). Da una visión de la
        # variedad del tráfico de un vistazo.
        summary = {
            "unique_ips": distinct_count(
                [{"$group": {"_id": "$dstIP"}}, {"$count": "n"}]
            ),
            "countries": distinct_count([
                {"$match": {"dstIpCountry": {"$nin": ["--", "", None]}}},
                {"$group": {"_id": "$dstIpCountry"}},
                {"$count": "n"},
            ]),
            # Protocolo maestro nDPI = parte anterior al punto de 'nDPIclass'.
            "protocols": distinct_count([
                {"$group": {"_id": {"$arrayElemAt": [
                    {"$split": [{"$ifNull": ["$nDPIclass", ""]}, "."]}, 0]}}},
                {"$match": {"_id": {"$nin": ["", None]}}},
                {"$count": "n"},
            ]),
            "orgs": distinct_count([
                {"$match": {"dstIPOrg": {"$nin": ["", "-", "--", None],
                                          "$not": {"$regex": "^!"}}}},
                {"$group": {"_id": "$dstIPOrg"}},
                {"$count": "n"},
            ]),
        }

        # Último y primer flujo + ventana configurable (window_s segundos).
        last_doc = _safe(
            lambda: col.find_one(sort=[("timeLast", -1)], projection={"timeLast": 1}), None)
        first_doc = _safe(
            lambda: col.find_one(sort=[("timeFirst", 1)], projection={"timeFirst": 1}), None)
        raw_last = last_doc.get("timeLast") if last_doc else None
        last_ts = _to_epoch(raw_last)
        first_ts = _to_epoch(first_doc.get("timeFirst")) if first_doc else None
        flows_window = 0 if raw_last is None else _safe(
            lambda: col.count_documents(
                {"timeLast": {"$gte": _threshold(raw_last, now - window_s)}}), 0)

        recent_flows = []
        try:
            cur = col.find(
                projection={
                    "timeFirst": 1, "timeLast": 1, "srcIP": 1, "srcPort": 1,
                    "dstIP": 1, "dstPort": 1, "l4Proto": 1, "nDPIclass": 1,
                    "dstPortClass": 1, "dstIpCountry": 1, "dstIPOrg": 1,
                    "pktsSnt": 1, "pktsRcvd": 1, "l7BytesSnt": 1, "l7BytesRcvd": 1,
                },
                sort=[("timeLast", -1)],
                limit=recent,
            )
            for d in cur:
                proto, service = _split_ndpi(d.get("nDPIclass"))
                recent_flows.append({
                    "id": str(d.get("_id")) if d.get("_id") is not None else None,
                    "ts": _to_epoch(d.get("timeLast")),
                    "ts_first": _to_epoch(d.get("timeFirst")),
                    "src": d.get("srcIP"),
                    "sport": d.get("srcPort"),
                    "dst": d.get("dstIP"),
                    "dport": d.get("dstPort"),
                    "port_class": d.get("dstPortClass"),
                    "l4": _PROTO_NAMES.get(d.get("l4Proto"), str(d.get("l4Proto"))),
                    "proto": proto,
                    "service": service,
                    "org": _clean_org(d.get("dstIPOrg")),
                    "country": d.get("dstIpCountry"),
                    "pkts_snt": d.get("pktsSnt"),
                    "pkts_rcvd": d.get("pktsRcvd"),
                    "bytes_snt": d.get("l7BytesSnt"),
                    "bytes_rcvd": d.get("l7BytesRcvd"),
                })
        except Exception:
            pass

        # Organizaciones de destino: se descartan las entradas técnicas de geoip
        # ('!...' multicast/privadas, '-'/'--' desconocidas).
        orgs = [o for o in self._top(col, "dstIPOrg", limit=20)
                if _clean_org(o["value"])][:8]

        return {
            "flows": total,
            "flows_window": flows_window,
            "window_s": window_s,
            "last_ts": last_ts,
            "first_ts": first_ts,
            "summary": summary,
            "ndpi": top("nDPIclass"),
            "countries": top("dstIpCountry", exclude=["--", "", None]),
            "orgs": orgs,
            "ports": top("dstPortClass", exclude=["unknown", "", None]),
            "recent": recent_flows,
        }

    def ip_detail(self, collection: str, ip: str, limit: int = 8) -> dict:
        """Perfil de una IP: con qué protocolos, países, organizaciones y pares
        (peers) ha hablado dentro de la colección de una sonda. Considera la IP
        tanto en origen como en destino."""
        empty = {
            "ip": ip, "flows": 0, "as_src": 0, "as_dst": 0,
            "protocols": [], "countries": [], "orgs": [], "ports": [], "peers": [],
        }
        col, error = self._open(collection)
        if error:
            return {**empty, "_error": error}
        if col is None:
            return empty

        base = {"$or": [{"srcIP": ip}, {"dstIP": ip}]}

        def top(field: str, extra: dict | None = None, clean=None) -> list:
            match = {**base, **extra} if extra else base
            out = self._top(col, field, limit=limit, match=match)
            return [o for o in out if clean(o["value"])] if clean else out

        try:
            flows = col.count_documents(base)
            as_src = col.count_documents({"srcIP": ip})
            as_dst = col.count_documents({"dstIP": ip})
        except Exception:
            flows = as_src = as_dst = 0

        # El "peer" es el otro extremo de cada flujo (el que no es 'ip').
        peers = _safe(lambda: [
            {"value": d["_id"], "count": d["n"]}
            for d in col.aggregate([
                {"$match": base},
                {"$project": {"peer": {"$cond": [
                    {"$eq": ["$srcIP", ip]}, "$dstIP", "$srcIP"]}}},
                {"$group": {"_id": "$peer", "n": {"$sum": 1}}},
                {"$sort": {"n": -1}},
                {"$limit": limit},
            ]) if d["_id"]
        ], [])

        return {
            "ip": ip,
            "flows": flows,
            "as_src": as_src,
            "as_dst": as_dst,
            "protocols": top("nDPIclass"),
            "countries": top("dstIpCountry", extra={"dstIpCountry": {"$nin": ["--", "", None]}}),
            "orgs": top("dstIPOrg", clean=_clean_org),
            "ports": top("dstPortClass", extra={"dstPortClass": {"$nin": ["unknown", "", None]}}),
            "peers": peers,
        }

    # Campos exportados (y su orden) para CSV/JSON.
    EXPORT_FIELDS = [
        "timeLast", "srcIP", "srcPort", "dstIP", "dstPort", "l4Proto",
        "nDPIclass", "dstPortClass", "dstIpCountry", "dstIPOrg",
        "l7BytesSnt", "l7BytesRcvd",
    ]

    def export_flows(self, collection: str, limit: int = 5000) -> list[dict]:
        """Devuelve los últimos 'limit' flujos como dicts planos para exportar.
        'timeLast' se normaliza a epoch. Vacío si la colección no existe."""
        col, _ = self._open(collection)
        if col is None:
            return []
        proj = {f: 1 for f in self.EXPORT_FIELDS}
        proj["_id"] = 0
        return _safe(lambda: [
            {**d, "timeLast": _to_epoch(d.get("timeLast"))}
            for d in col.find(projection=proj, sort=[("timeLast", -1)], limit=limit)
        ], [])

    def timeseries(self, collection: str, window_s: int = 900,
                   buckets: int = 30, by: str = "total") -> dict:
        """Serie temporal de flujos en 'buckets' intervalos sobre 'window_s' seg.

        'by' agrupa además cada intervalo por dimensión:
          total (solo recuento), protocol (nDPI maestro), country (país destino),
          l4 (protocolo de capa 4). Devuelve las 'keys' (top-6 series por volumen)
          y 'series' (siempre 'buckets' intervalos, rellenos con ceros)."""
        now = time.time()
        start = now - window_s
        step = window_s / buckets

        def base(keys):
            return {
                "window_s": window_s, "buckets": buckets, "bucket_s": step,
                "by": by, "keys": keys, "top_src": [], "top_dst": [],
                "series": [{"t": start + i * step, "total": 0,
                            "counts": {k: 0 for k in keys}} for i in range(buckets)],
            }

        col, error = self._open(collection)
        if error:
            return {**base([]), "_error": error}
        if col is None:
            return base([])

        start_ms = start * 1000.0
        bucket_ms = (window_s * 1000.0) / buckets
        start_dt = datetime.fromtimestamp(start, tz=timezone.utc)

        if by == "protocol":
            key_expr = {"$arrayElemAt": [{"$split": [{"$ifNull": ["$nDPIclass", ""]}, "."]}, 0]}
        elif by == "country":
            key_expr = "$dstIpCountry"
        elif by == "l4":
            key_expr = "$l4Proto"
        else:
            key_expr = {"$literal": "total"}

        pipeline = [
            {"$match": {"timeLast": {"$gte": start_dt}}},
            {"$project": {
                "b": {"$floor": {"$divide": [
                    {"$subtract": [{"$toLong": "$timeLast"}, start_ms]}, bucket_ms]}},
                "k": key_expr,
            }},
            {"$group": {"_id": {"b": "$b", "k": "$k"}, "n": {"$sum": 1}}},
        ]
        try:
            rows = list(col.aggregate(pipeline))
        except Exception as exc:
            return {**base([]), "_error": str(exc)}

        def keyname(k):
            # En modo L4, l4Proto es un número IANA: se traduce a nombre (TCP/UDP…).
            if by == "l4":
                try:
                    return _PROTO_NAMES.get(int(k), str(k))
                except (TypeError, ValueError):
                    return str(k)
            return str(k)

        # Elegir las top-6 series por volumen total (salvo en modo 'total').
        key_tot: dict = {}
        for r in rows:
            k = r["_id"].get("k")
            if k in (None, "", "--"):
                continue
            name = keyname(k)
            key_tot[name] = key_tot.get(name, 0) + r["n"]
        keys = [] if by == "total" else [
            k for k, _ in sorted(key_tot.items(), key=lambda x: -x[1])[:6]]
        keyset = set(keys)

        out = base(keys)
        series = out["series"]
        for r in rows:
            b = r["_id"].get("b")
            if b is None:
                continue
            b = int(b)
            if b == buckets:      # borde superior (timeLast == ahora)
                b = buckets - 1
            if b < 0 or b >= buckets:
                continue
            k = keyname(r["_id"].get("k"))
            n = r["n"]
            series[b]["total"] += n
            if by != "total" and k in keyset:
                series[b]["counts"][k] += n

        # Top talkers de la ventana: IPs origen/destino con más flujos.
        ventana = {"timeLast": {"$gte": start_dt}}
        out["top_src"] = self._top(col, "srcIP", limit=5, match=ventana)
        out["top_dst"] = self._top(col, "dstIP", limit=5, match=ventana)
        return out

    def flow_detail(self, collection: str, flow_id: str) -> dict:
        """Documento completo de un flujo por su _id: todos los campos que
        exporta Tranalyzer, serializados a tipos JSON."""
        try:
            oid = ObjectId(flow_id)
        except (InvalidId, TypeError):
            return {"_error": "id de flujo no válido"}
        col, error = self._open(collection)
        if error:
            return {"_error": error}
        if col is None:
            return {"_error": "colección no encontrada"}
        try:
            doc = col.find_one({"_id": oid})
        except Exception as exc:
            return {"_error": str(exc)}
        if not doc:
            return {"_error": "flujo no encontrado"}

        fields = {}
        for k, v in doc.items():
            if isinstance(v, datetime):
                if v.tzinfo is None:
                    v = v.replace(tzinfo=timezone.utc)
                v = v.isoformat()
            elif isinstance(v, (list, dict)):
                v = str(v)
            elif not isinstance(v, (str, int, float, bool, type(None))):
                v = str(v)   # ObjectId u otros tipos BSON
            fields[k] = v
        return {"id": flow_id, "fields": fields}

    def clear_collection(self, collection: str) -> dict:
        """Vacía la colección de una sonda (borra sus flujos, conserva índices)."""
        col, error = self._open(collection)
        if error:
            return {"ok": False, "error": error}
        if col is None:
            return {"ok": True, "deleted": 0}
        try:
            return {"ok": True, "deleted": col.delete_many({}).deleted_count}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}
