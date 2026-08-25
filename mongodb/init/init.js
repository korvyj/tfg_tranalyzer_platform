db = db.getSiblingDB('tranalyzer');

db.createCollection('flow');

db.flow.createIndex({ timeFirst: 1 });
db.flow.createIndex({ timeLast:  1 });
db.flow.createIndex({ srcIP: 1 });
db.flow.createIndex({ dstIP: 1 });
db.flow.createIndex({ srcIP: 1, dstIP: 1 });
db.flow.createIndex({ dstPort: 1 });

print('[init.js] Base de datos tranalyzer e índices creados correctamente.');
