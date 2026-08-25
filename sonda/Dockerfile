# Imagen de una SONDA: Tranalyzer2 (captura en vivo) + salt-minion, orquestados
# por supervisor. La captura se controla remotamente desde el coordinador
# (módulo Salt 'tranalyzer', que usa 'tranalyzerctl' -> supervisorctl).
#
# Construir:  docker build -t tfg-sonda .
# (requiere acceso a Internet para descargar Tranalyzer y salt-minion)
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ARG T2_TARBALL=tranalyzer2-0.9.4lmw1.tar.gz
ARG T2_URL=https://tranalyzer.com/download/tranalyzer/${T2_TARBALL}

# --- Dependencias de compilación de Tranalyzer + plugins, y utilidades ---
RUN apt-get update && apt-get install -y --no-install-recommends \
        autoconf autoconf-archive automake libbsd-dev libpcap-dev \
        libreadline-dev libtool make meson ninja-build zlib1g-dev gcc bzip2 \
        gawk libmongoc-dev libgcrypt20-dev \
        ca-certificates wget curl supervisor \
    && rm -rf /var/lib/apt/lists/*

# --- salt-minion (bootstrap oficial; -X = no arrancar servicios en build) ---
RUN curl -fsSL -o /tmp/bootstrap-salt.sh \
        https://github.com/saltstack/salt-bootstrap/releases/latest/download/bootstrap-salt.sh \
    && sh /tmp/bootstrap-salt.sh -X stable \
    && rm -f /tmp/bootstrap-salt.sh

# --- Tranalyzer2 + plugins necesarios ---
WORKDIR /opt
RUN wget -q "${T2_URL}" && tar xzf "${T2_TARBALL}" && rm -f "${T2_TARBALL}"
# El tarball extrae en /opt/tranalyzer2-0.9.4 (T2HOME)
ENV T2HOME=/opt/tranalyzer2-0.9.4
WORKDIR ${T2HOME}

# Construir núcleo + plugins de análisis + geoip + mongoSink.
# t2build == ${T2HOME}/autogen.sh
# 'yes |' responde al aviso de autogen.sh cuando se ejecuta como root (build no
# interactivo dentro del contenedor).
RUN yes | ./autogen.sh tranalyzer2 basicFlow basicStats tcpStates portClassifier \
        nDPI geoip mongoSink txtSink

# Aplicar la configuración del proyecto y reconstruir los plugins afectados
COPY tranalyzer/config/ /tmp/t2config/
RUN ./scripts/t2conf/t2conf mongoSink -C /tmp/t2config/mongoSink.config \
    && ./scripts/t2conf/t2conf geoip    -C /tmp/t2config/geoip.config \
    && ./scripts/t2conf/t2conf nDPI     -C /tmp/t2config/nDPI.config \
    && yes | ./autogen.sh -R nDPI geoip mongoSink

# Enlazar el binario y utilidades al PATH
RUN ln -sf ${T2HOME}/tranalyzer2/build/tranalyzer /usr/local/bin/tranalyzer

# --- Scripts de control ---
COPY tranalyzer/run-tranalyzer.sh /usr/local/bin/run-tranalyzer.sh
COPY tranalyzer/tranalyzerctl     /usr/local/bin/tranalyzerctl
RUN chmod +x /usr/local/bin/run-tranalyzer.sh /usr/local/bin/tranalyzerctl

COPY supervisord.conf /etc/supervisor/conf.d/tfg-sonda.conf

# salt-minion se configura montando /etc/salt/minion (ver docker-compose.yml)
CMD ["/usr/bin/supervisord", "-n", "-c", "/etc/supervisor/supervisord.conf"]
