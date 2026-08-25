# MongoDB — almacén central de flujos

```bash
cd platform/mongodb
docker compose up -d
mongosh tranalyzer
```

`init/init.js` crea la base de datos `tranalyzer`, la colección base `flow` y sus índices la
**primera** vez que arranca el contenedor (con el volumen vacío).

## Convención multi-sonda

Cada sonda escribe en su propia colección **`flow_<id>`** (p. ej. `flow_sonda_1`), fijada por
`MONGO_TABLE_NAME` (variable de entorno gestionada por Salt). De este modo el panel atribuye los
flujos a cada sonda recorriendo todas las colecciones que empiezan por `flow`.

Para crear los índices en la colección de una sonda nueva:

```bash
mongosh tranalyzer --eval '
  const c = "flow_sonda_1";
  db[c].createIndex({ timeFirst: 1 });
  db[c].createIndex({ timeLast: 1 });
  db[c].createIndex({ srcIP: 1 });
  db[c].createIndex({ dstIP: 1 });
  db[c].createIndex({ srcIP: 1, dstIP: 1 });
  db[c].createIndex({ dstPort: 1 });
'
```

## Consultas útiles

```js
db.getCollectionNames().filter(n => n.startsWith("flow"))   // sondas con datos
db.flow_sonda_1.countDocuments()
db.flow_sonda_1.find({}, { _id:0, srcIP:1, dstIP:1, nDPIclass:1 }).sort({ _id:-1 }).limit(10)
```
