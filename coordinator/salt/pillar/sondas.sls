# Configuración por sonda. Valores comunes + posibilidad de sobreescribir por id.
#
# La colección de MongoDB se deriva del id del minion (flow_<id>) para que el
# panel pueda atribuir los flujos a cada sonda.

{% set sid = grains['id'] | replace('-', '_') %}

# Interfaz por sonda; las que no aparezcan usan IFACE_POR_DEFECTO.
{% set IFACE_POR_DEFECTO = 'wlp2s0' %}
{% set IFACE_POR_SONDA = {} %}

tranalyzer:
  # Interfaz a capturar en la sonda
  iface: {{ IFACE_POR_SONDA.get(grains['id'], IFACE_POR_DEFECTO) }}
  # MongoDB central (coordinador por WireGuard)
  mongo_host: 10.0.0.1
  mongo_port: 27017
  mongo_dbname: tranalyzer
  # Colección propia de esta sonda
  mongo_table: flow_{{ sid }}
