# Comparativa: Docker frente a instalación nativa

El proyecto implementa dos formas de desplegar la plataforma. La elección entre una y otra
depende del entorno; la siguiente tabla muestra las diferencias.

| Criterio                        | Docker                                  | Instalación nativa (systemd)       |
|---------------------------------|-----------------------------------------|------------------------------------|
| Reproducibilidad                | Alta (misma imagen en todo el entorno)  | Media (pasos manuales)   |
| Consumo de recursos en una Raspberry Pi        | Mayor (runtime + imagen)                | Menor (procesos nativos)           |
| Captura en vivo                 | Requiere `--net=host` + `NET_RAW`       | Directa                            |
| Despliegue de una nueva sonda   | `docker compose up` + aceptar en Salt   | Instalar dependencias + compilar + Salt |
| Actualización                   | Nueva imagen + `up -d`                  | Repetir pasos / `t2build`          |

En ambos casos el resto de la plataforma es idéntico: el telecontrol se realiza con SaltStack
(master en el coordinador, minion en cada sonda), la configuración por sonda vive en el pillar, el
panel FastAPI lee el estado por salt-api y los flujos por MongoDB, y todo el tráfico de control y
de datos viaja por el túnel WireGuard.
