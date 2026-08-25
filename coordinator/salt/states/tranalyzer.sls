# Estado 'tranalyzer': gestión de la configuración de captura de cada sonda.
#
# Escribe /etc/tranalyzer/sonda.env a partir del pillar. run-tranalyzer.sh lo
# carga (y systemd lo usa como EnvironmentFile), de modo que cambiar la interfaz,
# el host de MongoDB o la colección se hace editando el pillar y ejecutando:
#     salt 'sonda-*' state.apply tranalyzer
#
# No recompila plugins: MONGO_* se aplica por variables de entorno (ENVCNTRL).

{% set t2 = pillar.get('tranalyzer', {}) %}

/etc/tranalyzer:
  file.directory:
    - mode: '0755'

/etc/tranalyzer/sonda.env:
  file.managed:
    - mode: '0644'
    - contents: |
        IFACE={{ t2.get('iface', 'eth0') }}
        MONGO_HOST={{ t2.get('mongo_host', '10.0.0.1') }}
        MONGO_PORT={{ t2.get('mongo_port', 27017) }}
        MONGO_DBNAME={{ t2.get('mongo_dbname', 'tranalyzer') }}
        MONGO_TABLE_NAME={{ t2.get('mongo_table', 'flow') }}
    - require:
      - file: /etc/tranalyzer

# Reiniciar la captura cuando cambie la configuración (via tranalyzerctl, que
# abstrae systemd/supervisor). onchanges => solo si el fichero .env cambió.
reiniciar-captura:
  cmd.run:
    - name: tranalyzerctl restart
    - onchanges:
      - file: /etc/tranalyzer/sonda.env
