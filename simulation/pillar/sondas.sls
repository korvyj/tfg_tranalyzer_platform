# Pillar de la SIMULACIÓN (un solo PC).
#
# Igual que coordinator/salt/pillar/sondas.sls pero con mongo_host apuntando al
# contenedor de MongoDB (10.0.0.10), porque en la simulación el coordinador
# ocupa el 10.0.0.1 y MongoDB es un contenedor aparte.

{% set sid = grains['id'] | replace('-', '_') %}

tranalyzer:
  # Dentro de un contenedor en red bridge, la interfaz se llama eth0.
  iface: eth0
  # MongoDB central de la simulación.
  mongo_host: 10.0.0.10
  mongo_port: 27017
  mongo_dbname: tranalyzer
  # Colección propia de esta sonda (flow_<id>) para atribución en el panel.
  mongo_table: flow_{{ sid }}
