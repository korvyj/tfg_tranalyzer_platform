# Simulación en un solo PC

Levanta **toda la plataforma** (coordinador, MongoDB y una sonda) como
contenedores en un único equipo, usando una red bridge `10.0.0.0/24` como
sustituto del túnel WireGuard. **No requiere WireGuard.**

No modifica los ficheros de despliegue reales (`coordinator/`, `sonda/`,
`mongodb/`): reutiliza sus imágenes y añade solo un pillar y un generador de
tráfico propios de la simulación.

## Topología simulada

| Contenedor              | Rol                              | IP (red simulada)          |
|-------------------------|----------------------------------|----------------------------|
| `tfg_sim_coordinador`   | salt-master + salt-api           | `10.0.0.1`                 |
| `tfg_sim_mongo`         | MongoDB                          | `10.0.0.10` (host `:27017`)|
| `tfg_sim_dashboard`     | Panel FastAPI                    | `10.0.0.11` → `localhost:8000` |
| `tfg_sim_sonda_1`       | Tranalyzer + salt-minion + tráfico | `10.0.0.2`               |

La sonda no ve tráfico real, así que un generador (`curl` en bucle) crea flujos
DNS/TCP/TLS en su `eth0` para que Tranalyzer los capture y `mongoSink` los envíe
a MongoDB (`flow_sonda_1`).

## Arrancar

> El puerto 27017 se publica en el host. Si ya hay otro MongoDB ocupándolo
> (p. ej. `tfg_mongo` de `mongodb/`), debe detenerse antes:
> `docker rm -f tfg_mongo`.

```bash
cd simulation
docker compose up -d --build     # la primera vez compila Tranalyzer (varios minutos)
```

## Aceptar la sonda y arrancar la captura desde el coordinador

El `autosign.conf` acepta automáticamente los minions `sonda-*`, de modo que la
sonda queda registrada sola. Después se opera igual que en el despliegue real:

```bash
docker exec tfg_sim_coordinador salt-key -L                       # ver la sonda aceptada
docker exec tfg_sim_coordinador salt 'sonda-*' test.ping
docker exec tfg_sim_coordinador salt 'sonda-*' saltutil.sync_modules
docker exec tfg_sim_coordinador salt 'sonda-1' state.apply tranalyzer   # escribe sonda.env desde el pillar
docker exec tfg_sim_coordinador salt 'sonda-1' tranalyzer.start
docker exec tfg_sim_coordinador salt 'sonda-1' tranalyzer.status
```

## Ver resultados

- **Panel**: http://localhost:8000
  - La tabla lista las sondas; al pulsar sobre el id se abre el detalle
    (`/sonda/<id>`): flujos por clasificación nDPI (L7), país de destino
    (GeoIP), servicio/puerto y protocolo, más los últimos flujos.
  - El detalle incluye un **panel de control** (iniciar / detener / reiniciar /
    aplicar config / cambiar interfaz) que lanza las acciones Salt sobre la
    sonda a través de salt-api. **El panel no tiene autenticación**: en el
    despliegue real esto se apoya en que solo es accesible por la red WireGuard;
    antes de exponerlo más allá debe añadirse autenticación.
- **Flujos en MongoDB**:
  ```bash
  docker exec tfg_sim_mongo mongosh --quiet tranalyzer \
    --eval 'db.flow_sonda_1.countDocuments()'
  ```

## Parar / limpiar

```bash
docker compose down            # parar (conserva volúmenes)
docker compose down -v         # parar y borrar datos/claves
```

## Añadir más sondas

Se duplica el servicio `sonda-1` en `docker-compose.yml` con otra IP (`10.0.0.3`),
otro `container_name` y un fichero de minion con `id: sonda-2`. El pillar y el
panel ya soportan múltiples `sonda-*` / `flow_*` sin cambios.

## Recreación del contenedor del coordinador

`docker compose up -d` y `docker compose restart` conservan la clave del master
(volumen `sim_master_pki`). Solo un `--force-recreate` del coordinador puede
cambiar la clave, que el minion rechazará (`Invalid master key`). Se resuelve
reseteando la clave cacheada del minion:

```bash
docker exec tfg_sim_sonda_1 rm -f /etc/salt/pki/minion/minion_master.pub
docker exec tfg_sim_sonda_1 supervisorctl restart salt-minion
```
