#!/usr/bin/env bash
#
# sim-traffic.sh - Generador de tráfico sintético (SOLO simulación).
#
# En un despliegue real la sonda captura tráfico de red real. En la simulación
# de un solo PC el contenedor solo ve su propia interfaz eth0, así que generamos
# tráfico saliente con curl (resuelve DNS y abre conexiones TCP/TLS). Tranalyzer,
# capturando eth0, convierte ese tráfico en flujos que mongoSink envía a MongoDB.
set -u

URLS=(
    "https://example.com"
    "https://www.wikipedia.org"
    "https://ubuntu.com"
    "http://neverssl.com"
    "https://www.google.com"
    "https://www.debian.org"
    "https://www.kernel.org"
)

echo "[sim-traffic] generando tráfico sintético hacia ${#URLS[@]} destinos"
while true; do
    for u in "${URLS[@]}"; do
        curl -s -o /dev/null --max-time 10 "$u" || true
        sleep 2
    done
    sleep 5
done
