# -*- coding: utf-8 -*-
"""Módulo de ejecución Salt: catálogo de comandos de la sonda.

Se sincroniza a las sondas con:  salt 'sonda-*' saltutil.sync_modules
y se invoca desde el coordinador, p. ej.:

    salt 'sonda-1' tranalyzer.start
    salt 'sonda-1' tranalyzer.status
    salt 'sonda-*' tranalyzer.set_interface eth1
    salt 'sonda-*' tranalyzer.apply_config

Abstrae el backend (systemd / supervisor / proceso) a través de
'tranalyzerctl', por lo que funciona igual en el despliegue nativo y en Docker.
"""

__virtualname__ = "tranalyzer"

CTL = "/usr/local/bin/tranalyzerctl"
ENV_FILE = "/etc/tranalyzer/sonda.env"


def __virtual__():
    return __virtualname__


def _ctl(action):
    """Ejecuta 'tranalyzerctl <action>' y devuelve stdout limpio."""
    ret = __salt__["cmd.run_all"]("{0} {1}".format(CTL, action), python_shell=False)
    if ret["retcode"] != 0:
        return {"ok": False, "error": ret.get("stderr") or ret.get("stdout")}
    return {"ok": True, "output": ret["stdout"].strip()}


def start():
    """Inicia la captura continua."""
    return _ctl("start")


def stop():
    """Detiene la captura."""
    return _ctl("stop")


def restart():
    """Reinicia la captura."""
    return _ctl("restart")


def status():
    """Devuelve 'running' o 'stopped'."""
    res = _ctl("status")
    return res.get("output", res)


def uptime():
    """Segundos que lleva capturando (0 si está parada)."""
    res = _ctl("uptime")
    out = res.get("output") if isinstance(res, dict) else res
    try:
        return int(str(out).strip())
    except (TypeError, ValueError):
        return 0


def version():
    """Versión de Tranalyzer instalada en la sonda."""
    ret = __salt__["cmd.run_all"]("tranalyzer -h", python_shell=False)
    first = (ret.get("stdout") or ret.get("stderr") or "").splitlines()
    return first[0] if first else "desconocida"


def get_config():
    """Devuelve la configuración efectiva de la sonda (fichero .env)."""
    if not __salt__["file.file_exists"](ENV_FILE):
        return {}
    cfg = {}
    for line in __salt__["file.read"](ENV_FILE).splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            cfg[k.strip()] = v.strip()
    return cfg


# Claves de sonda.env que se pueden editar desde el panel / set_config.
ALLOWED_KEYS = (
    "IFACE",
    "MONGO_HOST",
    "MONGO_PORT",
    "MONGO_DBNAME",
    "MONGO_TABLE_NAME",
)


def _write_env(key, value):
    """Escribe/actualiza KEY=value en sonda.env (crea el fichero si no existe)."""
    if not __salt__["file.file_exists"](ENV_FILE):
        __salt__["file.makedirs"](ENV_FILE)
        __salt__["file.touch"](ENV_FILE)
    __salt__["file.replace"](
        ENV_FILE,
        pattern="^{0}=.*".format(key),
        repl="{0}={1}".format(key, value),
        append_if_not_found=True,
    )


def set_interface(iface):
    """Cambia la interfaz de captura y reinicia. Persistente en el .env."""
    _write_env("IFACE", iface)
    return restart()


def set_config(**overrides):
    """Actualiza claves de sonda.env desde el panel y reinicia la captura.

    Solo se aceptan claves de ALLOWED_KEYS (IFACE, MONGO_*). Las claves de
    Salt internas (__pub_*) se ignoran. Devuelve la config resultante.
    """
    applied = {}
    for key, value in overrides.items():
        if key.startswith("__"):
            continue
        if key not in ALLOWED_KEYS:
            return {"ok": False, "error": "clave no permitida: {0}".format(key)}
        _write_env(key, str(value))
        applied[key] = str(value)
    if not applied:
        return {"ok": False, "error": "sin cambios"}
    res = restart()
    return {"ok": True, "applied": applied, "restart": res, "config": get_config()}


def interfaces():
    """Lista las interfaces de red de la sonda (sin loopback)."""
    try:
        ifaces = __salt__["network.interfaces"]()
    except Exception as exc:  # pragma: no cover
        return {"ok": False, "error": str(exc)}
    return sorted(name for name in ifaces if name != "lo")


def info():
    """Datos de la sonda para el panel: id, IPs, interfaces, versión y config."""
    cfg = get_config()
    ips = [ip for ip in __grains__.get("ipv4", []) if ip != "127.0.0.1"]
    return {
        "id": __grains__.get("id"),
        "os": __grains__.get("osfinger") or __grains__.get("os"),
        "ips": ips,
        "interfaces": interfaces(),
        "iface": cfg.get("IFACE"),
        "version": version(),
        "capturing": status() == "running",
        "uptime_s": uptime(),
        "config": cfg,
    }


def apply_config():
    """Reaplica el estado 'tranalyzer' (regenera .env desde el pillar)."""
    return __salt__["state.apply"]("tranalyzer")
