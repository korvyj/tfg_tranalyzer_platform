# Despliegue nativo

Instalación directa sobre el sistema operativo, con los servicios gestionados por `systemd`.

## 1. MongoDB (coordinador)

Se puede emplear Docker únicamente para la base de datos o una instalación nativa de MongoDB:

```bash
cd platform/mongodb && docker compose up -d
# o seguir https://www.mongodb.com/docs/manual/installation/
```

## 2. Coordinador — salt-master + salt-api

```bash
sudo apt-get update && sudo apt-get install -y salt-master salt-api
sudo cp platform/coordinator/salt/master        /etc/salt/master
sudo cp platform/coordinator/salt/autosign.conf /etc/salt/autosign.conf
sudo cp platform/coordinator/salt/dashboard-users /etc/salt/dashboard-users   # cambiar la clave
sudo mkdir -p /srv/salt /srv/pillar
sudo cp -r platform/coordinator/salt/states/*   /srv/salt/
sudo cp -r platform/coordinator/salt/_modules   /srv/salt/_modules
sudo cp -r platform/coordinator/salt/pillar/*   /srv/pillar/
sudo systemctl enable --now salt-master salt-api
```

## 3. Panel FastAPI (coordinador)

```bash
cd platform/coordinator/dashboard
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
SALT_API_PASS='...' MONGO_URI='mongodb://10.0.0.1:27017' python -m app.main
# (opcional) crear un servicio systemd que ejecute 'python -m app.main'
```

## 4. Sonda — Tranalyzer + salt-minion

```bash
# Tranalyzer (núcleo + plugins). Se descarga de tranalyzer.com y se compila:
#   ./setup.sh   (instala dependencias, plugins y alias t2*)
#   t2build tranalyzer2 basicFlow basicStats tcpStates portClassifier nDPI geoip mongoSink txtSink
# Aplicación de la configuración del proyecto:
cd platform/sonda/tranalyzer/config
t2conf mongoSink -C mongoSink.config
t2conf geoip    -C geoip.config
t2conf nDPI     -C nDPI.config
t2build -R nDPI geoip mongoSink

# Scripts de captura
sudo cp platform/sonda/tranalyzer/run-tranalyzer.sh /usr/local/bin/
sudo cp platform/sonda/tranalyzer/tranalyzerctl     /usr/local/bin/
sudo chmod +x /usr/local/bin/run-tranalyzer.sh /usr/local/bin/tranalyzerctl

# Servicio systemd de captura continua
sudo cp platform/sonda/systemd/tranalyzer.service /etc/systemd/system/
sudo mkdir -p /etc/tranalyzer
printf 'IFACE=eth0\nMONGO_HOST=10.0.0.1\n' | sudo tee /etc/tranalyzer/sonda.env
sudo systemctl daemon-reload
# No se habilita todavía: lo arranca el coordinador vía Salt.

# salt-minion
sudo apt-get install -y salt-minion
sudo cp platform/sonda/salt/minion /etc/salt/minion   # editar 'id' y 'master'
sudo systemctl enable --now salt-minion
```

## 5. Aceptar la sonda y operar desde el coordinador

```bash
sudo salt-key -A -y
salt 'sonda-*' test.ping
salt 'sonda-*' saltutil.sync_modules
salt 'sonda-1' tranalyzer.start
salt 'sonda-1' tranalyzer.status
```

## Ventajas / inconvenientes

| Ventajas                             | Inconvenientes                              |
|--------------------------------------|---------------------------------------------|
| Captura en vivo directa      | Instalación manual    |
| Menos capas que depurar              | Menos reproducible entre sondas             |
