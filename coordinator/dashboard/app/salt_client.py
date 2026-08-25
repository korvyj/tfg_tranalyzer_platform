"""Cliente HTTP para salt-api (rest_cherrypy).

Permite al panel consultar el estado de las sondas a través del coordinador:
qué minions responden y el estado de la captura en cada uno.
"""
from __future__ import annotations

import os
import httpx


def _payload(tgt: str, fun: str, arg: str | None = None, kwargs: dict | None = None) -> dict:
    """Construye el cuerpo de una llamada 'local' de salt-api."""
    payload = {"client": "local", "tgt": tgt, "fun": fun, "tgt_type": "glob"}
    if arg is not None:
        payload["arg"] = [arg]
    if kwargs:
        payload["kwarg"] = kwargs
    return payload


class SaltClient:
    def __init__(self) -> None:
        self.url = os.environ.get("SALT_API_URL", "http://127.0.0.1:8001").rstrip("/")
        self.user = os.environ.get("SALT_API_USER", "saltdash")
        self.password = os.environ.get("SALT_API_PASS", "cambia-esta-clave")
        self.eauth = os.environ.get("SALT_API_EAUTH", "file")
        self._token: str | None = None

    async def _login(self, client: httpx.AsyncClient) -> str:
        resp = await client.post(
            f"{self.url}/login",
            json={"username": self.user, "password": self.password, "eauth": self.eauth},
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        self._token = resp.json()["return"][0]["token"]
        return self._token

    async def _post(self, client: httpx.AsyncClient, payload: dict):
        """POST autenticado a salt-api; si el token ha caducado, reintenta una vez."""
        for intento in (1, 2):
            if not self._token:
                await self._login(client)
            resp = await client.post(
                f"{self.url}/",
                json=[payload],
                headers={"Accept": "application/json", "X-Auth-Token": self._token or ""},
            )
            if resp.status_code == 401 and intento == 1:
                self._token = None
                continue
            resp.raise_for_status()
            return resp.json()["return"][0]

    async def _run(self, client: httpx.AsyncClient, tgt: str, fun: str) -> dict:
        """Ejecuta una función Salt y devuelve el dict {minion: resultado}."""
        data = await self._post(client, _payload(tgt, fun))
        return data if isinstance(data, dict) else {}

    async def run_action(
        self, tgt: str, fun: str, arg: str | None = None, kwargs: dict | None = None
    ) -> dict:
        """Ejecuta una acción del catálogo Salt (start/stop/restart/…) en una sonda.

        Devuelve {'ok': bool, 'result': <retorno del minion>} o {'ok': False,
        'error': ...} si la API falla. 'arg' se pasa como argumento posicional
        (p. ej. la interfaz en set_interface); 'kwargs' como argumentos con
        nombre (p. ej. las claves de set_config).
        """
        async with httpx.AsyncClient(timeout=30.0) as client:
            try:
                data = await self._post(client, _payload(tgt, fun, arg, kwargs))
                return {"ok": True, "result": data}
            except Exception as exc:  # salt-api caído / sonda no responde
                return {"ok": False, "error": str(exc)}

    async def sonda_info(self, sonda_id: str) -> dict:
        """Datos de una sonda (id, IPs, interfaces, versión, config) vía tranalyzer.info."""
        res = await self.run_action(sonda_id, "tranalyzer.info")
        if not res.get("ok"):
            return {"_error": res.get("error", "salt-api no disponible")}
        data = res.get("result", {})
        info = data.get(sonda_id) if isinstance(data, dict) else None
        if not isinstance(info, dict):
            return {"_error": "la sonda no respondió a tranalyzer.info"}
        return info

    async def sonda_status(self) -> dict[str, dict]:
        """Devuelve {minion_id: {online: bool, capturing: bool}} para 'sonda-*'."""
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                pings = await self._run(client, "sonda-*", "test.ping")
            except Exception as exc:  # salt-api caído / sin sondas
                return {"_error": str(exc)}

            result = {m: {"online": bool(alive), "capturing": False}
                      for m, alive in pings.items()}

            # Estado de captura solo de los que responden
            online = ",".join(m for m, v in result.items() if v["online"])
            if online:
                try:
                    caps = await self._run(client, online, "tranalyzer.status")
                except Exception:
                    caps = {}
                for minion, state in caps.items():
                    result.setdefault(minion, {"online": True, "capturing": False})
                    result[minion]["capturing"] = str(state).strip() == "running"
            return result
