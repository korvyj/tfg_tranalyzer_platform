# Despliegue con Docker

Opción con todos los roles en contenedores. Cada rol tiene su `docker-compose.yml`:

| Rol          | Directorio     | Contenedor        | Qué levanta                          |
|--------------|----------------|-------------------|--------------------------------------|
| Base de datos| `mongodb/`     | `tfg_mongo`       | MongoDB 8 (`:27017`)                 |
| Coordinador  | `coordinator/` | `tfg_coordinador` | salt-master (`:4505/4506`) + salt-api (`:8001`) |
| Panel        | `coordinator/` | `tfg_dashboard`   | Panel FastAPI (`:8000`)              |
| Sonda        | `sonda/`       | `tfg_sonda`       | Tranalyzer2 + salt-minion            |

> **Aviso**: las imágenes descargan Tranalyzer y Salt de Internet durante el `build`. La primera
> compilación de la sonda tarda varios minutos.

> Para una prueba de la plataforma completa en un único equipo, `simulation/` la levanta sobre una
> red bridge, sin WireGuard y sin modificar nada. Ver
> [`../simulation/README.md`](../simulation/README.md).

---

## 0. Requisitos previos

1. **Docker Engine + plugin compose** (`docker compose version`) y permisos para utilizarlo.
2. **Acceso a Internet** en la máquina donde se realiza el `build`.
3. **La dirección `10.0.0.1` debe existir en el coordinador.** Es el requisito que más fallos
   provoca: todos los servicios usan `network_mode: host` y se enlazan a la IP de WireGuard.
   Si `10.0.0.1` no está configurada, el arranque falla, mostrando el siguiente error:

   ```
   salt-master: Unable to bind socket 10.0.0.1:4505 — Cannot assign requested address
   salt-api:    No socket could be created -- ('10.0.0.1', 8001)
   ```

   Para comprobar si está presente:

   ```bash
   ip -o addr show | grep -w 10.0.0.1 || echo "FAIL"
   ```

   **Caso A — despliegue real (coordinador y sondas en máquinas distintas):** se levanta el túnel
   WireGuard según [`../wireguard/README.md`](../wireguard/README.md); el coordinador recibe
   `10.0.0.1/24` y cada sonda `10.0.0.2`, `10.0.0.3`…

   ```bash
   sudo apt install -y wireguard-tools
   sudo wg-quick up wg0
   ```

   **Caso B — todo en un mismo equipo (pruebas):** basta con asignar esa dirección al host mediante una interfaz *dummy*, sin modificar
   ningún fichero de configuración:

   ```bash
   sudo ip link add dev tfg0 type dummy
   sudo ip addr add 10.0.0.1/24 dev tfg0
   sudo ip link set tfg0 up
   ```

   Para hacerla persistente, ejecutar los siguientes comandos:

   ```bash
   printf '[NetDev]\nName=tfg0\nKind=dummy\n' | sudo tee /etc/systemd/network/10-tfg0.netdev
   printf '[Match]\nName=tfg0\n\n[Network]\nAddress=10.0.0.1/24\n' | sudo tee /etc/systemd/network/10-tfg0.network
   sudo systemctl enable --now systemd-networkd
   ```

4. **Selección de la interfaz de captura.** El valor por defecto `eth0` no existe en muchos equipos.
   Para listar las disponibles:

   ```bash
   ip -br link
   ```

   El nombre de la interfaz con tráfico real se utilizará en el paso 3.

Todas las rutas de esta guía son relativas a la **raíz del repositorio**.

---

## 1. MongoDB (en el coordinador)

```bash
cd mongodb
docker compose up -d
docker ps | grep tfg_mongo
```

- Escucha en `0.0.0.0:27017` para recibir los flujos de las sondas por el túnel.
- `init/init.js` crea la base `tranalyzer` y los índices. Se ejecuta **solo la primera vez**
  (mientras el volumen `mongo_data` esté vacío).

---

## 2. Coordinador (salt-master + salt-api + panel)

**Antes de levantarlo** se debe sustituir el marcador `<password>` por una contraseña real en
**los dos sitios, que han de coincidir**:

| Fichero                                   | Línea                             |
|-------------------------------------------|-----------------------------------|
| `coordinator/salt/dashboard-users`        | `saltdash:<password>`             |
| `coordinator/docker-compose.yml`          | `SALT_API_PASS: "<password>"`     |

El despliegue de simulación monta ese mismo fichero de usuarios, de modo que
`simulation/docker-compose.yml` lleva el mismo marcador y debe recibir la misma contraseña.

> El eauth `file` de Salt procesa **todas** las líneas del fichero de usuarios y falla en la
> primera que no tenga el formato `usuario:contraseña`. Ese fichero no admite comentarios ni
> espacios.

```bash
cd coordinator
docker compose up -d --build
docker compose ps
```

Comprobación de que **los dos** procesos están levantados:

```bash
docker exec tfg_coordinador supervisorctl status
# salt-api      RUNNING
# salt-master   RUNNING
```

Detalles de la imagen:

- Usa `network_mode: host`: master en `10.0.0.1:4505/4506`, salt-api en `:8001`, panel en `:8000`.
- Se montan tres árboles (ver `docker-compose.yml`):
  - `salt/states` → `/srv/salt` (primer `file_roots`)
  - `salt/pillar` → `/srv/pillar` (`pillar_roots`)
  - `salt/` → `/srv/salt-extra` (segundo `file_roots`, aporta `_modules/`)
- Se emplean dos `file_roots` porque montar `salt/_modules` **dentro** de `/srv/salt` supone un
  montaje anidado sobre un bind `:ro` y Docker no puede crear el punto de montaje
  (`read-only file system`). Salt busca `_modules` en cada `file_roots`, de modo que
  `saltutil.sync_modules` encuentra el módulo.
- La clave del master persiste en el volumen `master_pki`.

---

## 3. Sonda (tranalyzer + salt-minion)

Previamente se editan dos ficheros:

1. `sonda/salt/minion` → `id` único (`sonda-1`, `sonda-2`, …) y `master: 10.0.0.1`.
2. `sonda/docker-compose.yml` → `IFACE` (la interfaz real del paso 0.4) y `MONGO_HOST`.

```bash
cd sonda
docker compose up -d --build      # la primera vez compila Tranalyzer: varios minutos
docker logs -f tfg_sonda          # Ctrl+C para salir
```

- **Captura en vivo en contenedor**: requiere `network_mode: host` + `cap_add: [NET_RAW, NET_ADMIN]`
  (ya incluidos) para capturar tráfico de una interfaz real del host.
- `tranalyzer` **no arranca solo** (`autostart=false` en supervisor): lo inicia el coordinador por
  Salt en el paso 4. El `salt-minion` sí arranca solo.

---

## 4. Registrar la sonda y arrancar la captura

Todo se ejecuta desde el coordinador:

```bash
# La sonda se acepta sola (autosign.conf acepta el patrón 'sonda-*'); esto solo lo verifica
docker exec tfg_coordinador salt-key -L

# Con autosign.conf desactivado, se acepta manualmente:
docker exec tfg_coordinador salt-key -A -y

docker exec tfg_coordinador salt 'sonda-*' test.ping

# Copia el módulo 'tranalyzer' a la sonda. IMPRESCINDIBLE: sin esto, cualquier
# tranalyzer.* falla con "'tranalyzer.start' is not available".
docker exec tfg_coordinador salt 'sonda-*' saltutil.sync_modules

# Renderiza /etc/tranalyzer/sonda.env en la sonda a partir del pillar
docker exec tfg_coordinador salt 'sonda-1' state.apply tranalyzer

docker exec tfg_coordinador salt 'sonda-1' tranalyzer.start
docker exec tfg_coordinador salt 'sonda-1' tranalyzer.status     # -> running
```

> **`saltutil.sync_modules` debe repetirse** cada vez que se edite
> `coordinator/salt/_modules/tranalyzer.py`: los minions usan su copia local.

### Configuración por sonda (pillar)

La interfaz, el MongoDB y la colección de cada sonda salen de
`coordinator/salt/pillar/sondas.sls`. La colección se deriva del id del minion
(`sonda-1` → `flow_sonda_1`) para que el panel atribuya los flujos a cada sonda.

Para cambiar la interfaz de una sonda de forma permanente, se edita el mapa `iface` del pillar y se
reaplica:

```bash
docker exec tfg_coordinador salt 'sonda-1' state.apply tranalyzer
```

Para un cambio puntual, sin tocar el pillar, desde el panel o con:

```bash
docker exec tfg_coordinador salt 'sonda-1' tranalyzer.set_interface wlp2s0
```

`state.apply tranalyzer` **revierte** los cambios puntuales a lo que indique el pillar: el pillar es
la prioridad y `set_config`/`set_interface` son sobrescrituras locales.

---

## 5. Comprobar que funciona

```bash
# 1. Estado de la flota según Salt
docker exec tfg_coordinador salt 'sonda-*' tranalyzer.status
docker exec tfg_coordinador salt 'sonda-1' tranalyzer.info

# 2. Flujos llegando a MongoDB (debe crecer)
docker exec tfg_mongo mongosh --quiet tranalyzer --eval 'db.flow_sonda_1.countDocuments()'

# 3. API del panel
curl -s http://10.0.0.1:8000/api/status | head -c 400
```

4. **Panel web**: <http://10.0.0.1:8000>. Al pulsar sobre el id de una sonda se abre su detalle
   `/sonda/<id>`: clasificación nDPI, país y organización de destino (GeoIP), servicio/puerto,
   últimos flujos y el panel de control (iniciar/detener/reiniciar, cambiar interfaz, editar
   `sonda.env`, vaciar datos).

---

## 6. Parar, reiniciar y dejar el entorno limpio

Los comandos `docker compose` se lanzan **desde el directorio de cada rol**.

### Parar sin perder nada

```bash
cd coordinator && docker compose stop
cd ../sonda     && docker compose stop
cd ../mongodb   && docker compose stop
# volver a arrancar: docker compose start
```

### Reiniciar un servicio

```bash
cd coordinator && docker compose restart salt-master
cd sonda       && docker compose restart
```

Tras modificar el código del panel hay que **reconstruir** la imagen, que lo lleva dentro y no como
volumen:

```bash
cd coordinator && docker compose up -d --build dashboard
```

Tras modificar `docker-compose.yml` o un fichero montado (`salt/master`, pillar, states), basta con
recrear:

```bash
cd coordinator && docker compose up -d --force-recreate
```

### Borrar solo los datos capturados

Conserva la instalación y vacía los flujos de una sonda:

```bash
# Opción A: botón "Vaciar datos" en el panel, en /sonda/<id>
# Opción B: manualmente
docker exec tfg_mongo mongosh --quiet tranalyzer --eval 'db.flow_sonda_1.deleteMany({})'
```

### Reset total (volver al punto de partida)

Borra contenedores, **volúmenes** (datos de MongoDB y claves Salt) y redes:

```bash
cd sonda       && docker compose down -v
cd ../coordinator && docker compose down -v
cd ../mongodb  && docker compose down -v
```

Para liberar además las imágenes y recompilar todo desde cero:

```bash
docker rmi tfg-sonda tfg-coordinador tfg-dashboard
docker builder prune -f
```

Y para retirar la interfaz *dummy* del paso 0 (caso B):

```bash
sudo ip link del tfg0
# si se hizo persistente:
sudo rm -f /etc/systemd/network/10-tfg0.netdev /etc/systemd/network/10-tfg0.network
sudo systemctl restart systemd-networkd
```

Tras el reset se vuelve a empezar por el paso 0. Como el volumen `mongo_data` ya no existe,
`init/init.js` se ejecutará otra vez y recreará los índices.

### Reset solo de las claves Salt

Útil cuando la sonda deja de responder con `Invalid master key` o `The master key has changed`,
lo que ocurre al recrear el coordinador si su clave cambia. No es necesario borrar MongoDB:

```bash
# En la sonda: olvidar la clave cacheada del master
docker exec tfg_sonda rm -f /etc/salt/pki/minion/minion_master.pub
docker exec tfg_sonda supervisorctl restart salt-minion

# En el coordinador: volver a aceptar la sonda si hiciera falta
docker exec tfg_coordinador salt-key -L
docker exec tfg_coordinador salt-key -A -y
```

Reset completo de la identidad Salt (ambos extremos; obliga a re-registrar todas las sondas):

```bash
cd coordinator && docker compose down -v && docker compose up -d
cd ../sonda    && docker compose down -v && docker compose up -d
```

---

## 7. Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| `create mountpoint for /srv/salt/_modules: read-only file system` | Montaje anidado dentro de un bind `:ro` | Usar el montaje `/srv/salt-extra` descrito en el paso 2 |
| `'tranalyzer.start' is not available` | El módulo no está sincronizado en la sonda | `salt '*' saltutil.sync_modules` |
| `salt-key -L` no lista la sonda | El minion no llega al master | Comprobar que `10.0.0.1` es alcanzable, el `master:` de `sonda/salt/minion` y `docker logs tfg_sonda` |
| `Invalid master key` en la sonda | La clave del master cambió al recrear el contenedor | "Reset solo de las claves Salt" |
| Salt responde pero MongoDB está vacío | Interfaz de captura sin tráfico o inexistente | `ip -br link` en el host y `tranalyzer.set_interface <iface>` |
| El eauth de salt-api falla al iniciar sesión | `dashboard-users` y `SALT_API_PASS` no coinciden | Paso 2 |

---

## Ventajas / inconvenientes

| Ventajas                                  | Inconvenientes                                  |
|-------------------------------------------|-------------------------------------------------|
| Reproducible, aislado, fácil de desplegar | La captura necesita `--net=host` + `NET_RAW`    |
| Mismas imágenes en todas las sondas       | Imagen más pesada; build inicial largo en una RPi |
