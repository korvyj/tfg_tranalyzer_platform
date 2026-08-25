# Imagen del COORDINADOR: salt-master + salt-api, orquestados por supervisor.
# El árbol de estados/pillar/_modules y la configuración se montan por volumen
# (ver docker-compose.yml).
#
# Construir:  docker build -t tfg-coordinador .
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget supervisor python3-cherrypy3 \
    && rm -rf /var/lib/apt/lists/*

# salt-master + salt-api (bootstrap oficial; -M master, -X no arrancar servicios)
RUN curl -fsSL -o /tmp/bootstrap-salt.sh \
        https://github.com/saltstack/salt-bootstrap/releases/latest/download/bootstrap-salt.sh \
    && sh /tmp/bootstrap-salt.sh -M -X stable \
    && apt-get update && apt-get install -y --no-install-recommends salt-api \
    && rm -rf /var/lib/apt/lists/* /tmp/bootstrap-salt.sh

COPY supervisord.conf /etc/supervisor/conf.d/tfg-coordinador.conf

CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
