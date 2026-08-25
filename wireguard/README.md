# WireGuard — VPN entre sondas y coordinador

WireGuard conecta de forma segura las **sondas remotas** con el **coordinador / servidor
central**, permitiendo que el tráfico de control (Salt) y de datos (flujos a MongoDB) viaje
cifrado por el túnel `10.0.0.0/24` sin exponer ningún puerto a Internet.

```
  Sonda (RPi)      10.0.0.2..N            Coordinador / servidor   10.0.0.1
  ┌───────────────────────────┐          ┌─────────────────────────────────┐
  │ wg0: 10.0.0.2             │          │ wg0: 10.0.0.1                   │
  │ salt-minion ───────────── │ 4505/6 → │ salt-master + salt-api          │
  │ tranalyzer + mongoSink ── │ 27017  → │ MongoDB + panel FastAPI         │
  └───────────────────────────┘          └─────────────────────────────────┘
```

## Puertos que viajan por el túnel

| Puerto        | Servicio                    | Sentido            |
|---------------|-----------------------------|--------------------|
| `4505`/`4506` | salt-master (ZeroMQ)        | sonda → coordinador |
| `27017`       | MongoDB (mongoSink)         | sonda → coordinador |
| `8000`        | Panel FastAPI (local)       | en el coordinador   |
| `8001`        | salt-api (REST, local)      | en el coordinador   |

> Salt y salt-api solo necesitan escuchar en `10.0.0.1`. El panel puede quedarse en `127.0.0.1`
> del coordinador si se accede localmente.

## Instalación (servidor y cada sonda)

```bash
sudo apt-get update && sudo apt-get install -y wireguard
```

## Generar claves (una vez por nodo)

```bash
wg genkey > private.key && chmod 600 private.key
wg pubkey < private.key > public.key
cat public.key   # se comparte con el otro extremo
```

## Configurar

```bash
# En el coordinador
sudo cp server/wg0.conf.example /etc/wireguard/wg0.conf
# En cada sonda
sudo cp clients/wg0.conf.example /etc/wireguard/wg0.conf

sudo chmod 600 /etc/wireguard/wg0.conf
sudo nano /etc/wireguard/wg0.conf   # rellenar claves, IPs y Endpoint
```

En el servidor se añade un bloque `[Peer]` por cada sonda (ver `server/wg0.conf.example`).

## Activar el túnel

```bash
sudo wg-quick up wg0
sudo wg show                     # verificar handshake
sudo systemctl enable wg-quick@wg0   # (opcional) arranque automático
```

## Verificar conectividad (desde la sonda)

```bash
ping -c 3 10.0.0.1
nc -zv 10.0.0.1 27017    # MongoDB
nc -zv 10.0.0.1 4505     # salt-master
```
