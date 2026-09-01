// Se ejecuta solo la primera vez que arranca el contenedor (volumen vacío).
//
// No crea ninguna colección: cada sonda escribe en la suya, 'flow_<id>', que
// mongoSink crea al insertar el primer flujo. Los índices de esas colecciones
// se aplican por sonda (ver mongodb/README.md).

db = db.getSiblingDB('tranalyzer');

print('[init.js] Base de datos tranalyzer lista.');
