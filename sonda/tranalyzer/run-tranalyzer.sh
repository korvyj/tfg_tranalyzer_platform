#!/usr/bin/env bash
#
# run-tranalyzer.sh - Captura continua en vivo y exportación a MongoDB.
#
# Sustituye al antiguo 't2continuous': Tranalyzer captura de forma nativa con
# 'tranalyzer -i IFACE'. En ese modo el plugin mongoSink inserta cada flujo
# terminado directamente en MongoDB, sin rotación de PCAP y sin pérdida de datos.
#
# Variables de entorno (con valores por defecto):
#   IFACE        Interfaz a capturar          (por defecto: primera no-loopback)
#   OUTPUT_DIR   Prefijo de ficheros locales  (por defecto: /var/lib/tranalyzer)
#   PLUGINS_DIR  Directorio de plugins        (por defecto: ~/.tranalyzer/plugins)
#   MONGO_HOST   Host de MongoDB              (por defecto: 10.0.0.1)
#   MONGO_PORT   Puerto de MongoDB            (por defecto: 27017)
#   MONGO_DBNAME Base de datos                (por defecto: tranalyzer)
#
# MONGO_HOST/PORT/DBNAME/TABLE_NAME se pasan a mongoSink mediante el mecanismo
# ENVCNTRL de Tranalyzer, por lo que apuntar todas las sondas al MongoDB central
# (y darle una colección propia a cada una) no requiere recompilar el plugin.
set -euo pipefail

# Configuración gestionada por Salt (estado tranalyzer). Si existe, tiene
# prioridad sobre los valores por defecto de abajo.
[[ -f /etc/tranalyzer/sonda.env ]] && source /etc/tranalyzer/sonda.env

IFACE="${IFACE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-/var/lib/tranalyzer}"
PLUGINS_DIR="${PLUGINS_DIR:-${HOME}/.tranalyzer/plugins}"

export MONGO_HOST="${MONGO_HOST:-10.0.0.1}"
export MONGO_PORT="${MONGO_PORT:-27017}"
export MONGO_DBNAME="${MONGO_DBNAME:-tranalyzer}"
# Colección por sonda para que el panel atribuya los flujos (flow_<host>).
export MONGO_TABLE_NAME="${MONGO_TABLE_NAME:-flow_$(hostname | tr '-' '_')}"

# Detectar interfaz por defecto si no se indicó
if [[ -z "${IFACE}" ]]; then
    IFACE="$(ip -o link show | awk -F': ' '!/lo/{print $2; exit}')"
    if [[ -z "${IFACE}" ]]; then
        echo "[ERROR] No se pudo detectar la interfaz. Define IFACE." >&2
        exit 1
    fi
fi

# Localizar el binario de tranalyzer
T2_BIN="$(command -v tranalyzer 2>/dev/null || true)"
if [[ -z "${T2_BIN}" ]]; then
    echo "[ERROR] Binario 'tranalyzer' no encontrado en PATH." >&2
    echo "        Instálalo (setup.sh / t2build) o usa el despliegue Docker." >&2
    exit 1
fi

mkdir -p "${OUTPUT_DIR}"

echo "[INFO] Interfaz     : ${IFACE}"
echo "[INFO] MongoDB      : ${MONGO_HOST}:${MONGO_PORT}/${MONGO_DBNAME}.${MONGO_TABLE_NAME}"
echo "[INFO] Plugins      : ${PLUGINS_DIR}"
echo "[INFO] Salida local : ${OUTPUT_DIR}/$(hostname)"
echo "[INFO] Captura continua en vivo (Ctrl+C para detener)"

# -i IFACE : captura en vivo continua
# -p DIR   : cargar plugins desde DIR
# -w PREF  : prefijo de los ficheros de salida locales (además de MongoDB)
exec "${T2_BIN}" -i "${IFACE}" -p "${PLUGINS_DIR}" -w "${OUTPUT_DIR}/$(hostname)_"
