# Arquitectura

Plataforma de captura y clasificación de tráfico gestionada de forma remota.

```
                          WireGuard 10.0.0.0/24
  ┌─────────────────────────────┐        ┌──────────────────────────────────────────────┐
  │ SONDA (RPi)   10.0.0.2..N   │        │ COORDINADOR / SERVIDOR   10.0.0.1            │
  │                             │        │                                              │
  │  salt-minion  ───────────── │ 4505/6 │ ──▶ salt-master ──▶ salt-api (REST)          │
  │                             │        │                          ▲                   │
  │  tranalyzer -i eth0         │        │        panel FastAPI ─────┘  (estado)        │
  │   ├─ nDPI  (L7)             │        │                          │                   │
  │   ├─ geoip (geo)            │        │                          ▼ pymongo           │
  │   └─ mongoSink ──flujos──── │ 27017  │ ──────────────▶  MongoDB (tranalyzer/flow_*) │
  └─────────────────────────────┘        └──────────────────────────────────────────────┘
                                                                │
                                                                ▼
                                                               IDS
```

## Componentes

### Coordinador (`coordinator/`)
- **salt-master**: gestiona la flota de sondas. Punto único de control.
- **Catálogo de comandos** = módulo de ejecución Salt `tranalyzer`
  (`coordinator/salt/_modules/tranalyzer.py`): `start`, `stop`, `restart`, `status`,
  `set_interface`, `apply_config`, `version`, `get_config`.
- **Gestión de configuración** = estado `tranalyzer.sls` + datos por sonda en el pillar
  (`pillar/sondas.sls`). Para cambiar la interfaz, el host o la colección de una sonda se edita el
  pillar y se ejecuta `salt 'sonda-*' state.apply tranalyzer`.
- **salt-api** (rest_cherrypy): expone Salt por REST para el panel.
- **Panel FastAPI** (`coordinator/dashboard/`): co-ubicado; muestra el estado de cada sonda.

### Sonda (`sonda/`)
- **salt-minion**: agente controlado por el coordinador.
- **Tranalyzer2** en **captura continua en vivo** (`tranalyzer -i IFACE`) con los plugins
  `nDPI` (clasificación L7), `geoip` (geolocalización) y `mongoSink` (exportación a MongoDB).
- La captura se controla con `tranalyzerctl`, que abstrae el backend (systemd en la instalación
  nativa, supervisor en Docker) para que el módulo Salt funcione igual en ambos despliegues.

### MongoDB (`mongodb/`)
- Almacén central de flujos. Cada sonda escribe en su colección `flow_<id>`, de modo que el panel
  atribuye los flujos por sonda.

### WireGuard (`wireguard/`)
- Túnel `10.0.0.0/24` que transporta cifrado el control (Salt 4505/4506) y los datos
  (mongoSink → 27017). Ningún servicio queda expuesto a Internet.

## Captura continua

Tranalyzer captura de forma nativa con `-i IFACE`. En ese modo `mongoSink` inserta **cada flujo
terminado** directamente en MongoDB, sin rotación de PCAP ni ventanas de corte. El servicio se
ejecuta con reinicio automático (`Restart=always` / supervisor `autorestart`) para operar de forma
continua.

## Frontera con el IDS

MongoDB es el almacén compartido de flujos y el punto de integración con el IDS, que los consume
leyendo de la base de datos.
