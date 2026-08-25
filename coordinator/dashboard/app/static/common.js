// Helpers compartidos por el listado de la flota (app.js) y el detalle de una
// sonda (sonda.js). Se carga antes que ellos en ambas plantillas.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Número con separador de miles en español.
const nfmt = (n) => (n || 0).toLocaleString("es");

// Antigüedad del último flujo, en la unidad más legible.
function fmtLastSeen(s) {
  if (s === null || s === undefined) return "—";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.round(s / 3600)} h`;
}
