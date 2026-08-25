# Plataforma de captura y clasificación de tráfico con telecontrol

Flota de **sondas** que capturan tráfico con **Tranalyzer2** (clasificación L7 con `nDPI`,
geolocalización con `geoip`) y exportan los flujos a **MongoDB** con `mongoSink`. Un **coordinador**
gestiona las sondas de forma remota con **SaltStack** y ofrece un **panel web (FastAPI)** con el
estado de la flota. Todo viaja cifrado por **WireGuard**.

```
  SONDA (RPi)                COORDINADOR / SERVIDOR             
  tranalyzer -i eth0  ─┐     salt-master + salt-api  ─┐               IDS
  nDPI · geoip · mongoSink   panel FastAPI            │                ▲
  salt-minion  ─────── WireGuard ──────────────── MongoDB (flow_*) ────┘
```

Ver [`docs/architecture.md`](docs/architecture.md) para más detalle.

## Estructura

```
platform/
├── coordinator/     # salt-master, salt-api, catálogo de comandos (Salt), panel FastAPI
├── sonda/           # tranalyzer (captura continua), salt-minion, control (systemd/supervisor)
├── mongodb/         # base de datos central (docker-compose + init)
├── wireguard/       # VPN (ejemplos de configuración)
└── docs/            # arquitectura y guías de despliegue (Docker y nativo)
```

## Puesta en marcha

Se elige uno de los dos despliegues ([comparativa](docs/comparativa-despliegues.md)):

- **Docker (todos los roles en contenedores)** → [`docs/deploy-docker.md`](docs/deploy-docker.md)
- **Nativo (systemd, sin contenedores)** → [`docs/deploy-nativo.md`](docs/deploy-nativo.md)

Resumen:

> **Requisito previo**: el coordinador debe tener la dirección `10.0.0.1` (la de WireGuard); si no,
> salt-master y salt-api no arrancan. En un despliegue de un solo equipo se puede sustituir por una
> interfaz *dummy* — ver el paso 0 de [`docs/deploy-docker.md`](docs/deploy-docker.md).

```bash
# 1. Base de datos
cd mongodb && docker compose up -d

# 2. Coordinador (salt-master + salt-api + panel) → http://10.0.0.1:8000
# 3. Sonda (salt-minion + tranalyzer), aceptar su clave en el coordinador
# 4. Operar la flota desde el coordinador:
salt 'sonda-*' test.ping
salt 'sonda-*' saltutil.sync_modules
salt 'sonda-1' tranalyzer.start
salt 'sonda-1' tranalyzer.status
```

## Catálogo de comandos (Salt)

Módulo `coordinator/salt/_modules/tranalyzer.py`, invocable desde el coordinador:

| Comando                              | Acción                                            |
|--------------------------------------|---------------------------------------------------|
| `tranalyzer.start` / `stop` / `restart` | Controla la captura continua                    |
| `tranalyzer.status`                  | `running` / `stopped`                             |
| `tranalyzer.set_interface eth1`      | Cambia la interfaz y reinicia (persistente)       |
| `tranalyzer.get_config`              | Configuración efectiva de la sonda                |
| `tranalyzer.apply_config`            | Reaplica el estado (regenera config desde pillar) |
| `tranalyzer.version`                 | Versión de Tranalyzer                             |

La configuración por sonda (interfaz, host de MongoDB, colección) vive en
[`coordinator/salt/pillar/sondas.sls`](coordinator/salt/pillar/sondas.sls). Para cambiarla se edita
el pillar y se ejecuta `salt 'sonda-*' state.apply tranalyzer`.

## Notas

- **Captura continua**: se usa el modo nativo `tranalyzer -i IFACE`; `mongoSink` inserta cada flujo
  terminado en MongoDB.
- **Plugins utilizados**: `nDPI`, `geoip` y `mongoSink` son estándar de Tranalyzer; el repo
  solo guarda su **configuración** (`sonda/tranalyzer/config/*.config`), no su código.
