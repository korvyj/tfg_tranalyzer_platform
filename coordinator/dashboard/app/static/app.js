// Listado de la flota. Cada sonda ocupa una fila con su propio trazo de
// actividad: el mismo componente que la banda de registro de la vista de
// detalle, reducido, para que una sonda parada se reconozca de un vistazo sin
// leer una sola cifra.

const REFRESH_MS = 5000;
const SPARK_WINDOW_S = 900;   // misma ventana que la banda de la vista de detalle
const SPARK_BUCKETS = 40;

// Trazo por sonda: se cachea entre refrescos para no dejar la celda en blanco
// mientras llega la respuesta.
const sparks = new Map();

function sparkSvg(series) {
  const pts = (series || []).map((b) => b.total || 0);
  if (!pts.length) return "";
  const W = 160, H = 26, max = Math.max(1, ...pts);
  const x = (i) => (pts.length === 1 ? W : (i / (pts.length - 1)) * W);
  const y = (v) => H - 2 - (v / max) * (H - 6);
  const linea = pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path class="strip-area" d="${linea} L${W} ${H} L0 ${H} Z"/>` +
    `<path class="strip-line" d="${linea}"/></svg>`;
}

function row(s) {
  const conn = s.online
    ? '<span class="dot ok"></span>Online'
    : '<span class="dot bad"></span>Sin conexión';
  const cap = s.capturing
    ? '<span class="pill on">Capturando</span>'
    : '<span class="pill off">Parada</span>';
  const spark = sparks.get(s.id);
  return `<tr>
    <td><a href="/sonda/${encodeURIComponent(s.id)}">${s.id}</a></td>
    <td>${conn}</td>
    <td>${cap}</td>
    <td class="sparkcell">${spark || '<span class="muted small">—</span>'}</td>
    <td class="num">${nfmt(s.flows)}</td>
    <td class="num">${nfmt(s.flows_5m)}</td>
    <td class="num">${fmtLastSeen(s.last_seen_s)}</td>
    <td class="mono small">${s.collection}</td>
  </tr>`;
}

// El trazo se pide aparte del estado: si falla, la fila sigue mostrándose.
async function loadSpark(id) {
  try {
    const res = await fetch(`/api/sonda/${encodeURIComponent(id)}/timeseries` +
      `?by=total&window=${SPARK_WINDOW_S}&buckets=${SPARK_BUCKETS}`);
    const d = await res.json();
    const svg = sparkSvg(d.series);
    if (svg) sparks.set(id, svg);
  } catch (e) { /* la fila se pinta sin trazo */ }
}

async function refresh() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    await Promise.all(data.sondas.map((s) => loadSpark(s.id)));
    $("#sondas tbody").innerHTML = data.sondas.length
      ? data.sondas.map(row).join("")
      : '<tr><td colspan="8" class="muted">Todavía no hay ninguna sonda dada de alta.</td></tr>';
    const d = new Date(data.generated_at * 1000);
    $("#updated").textContent = "Actualizado " + d.toLocaleTimeString("es");
  } catch (e) {
    $("#updated").textContent = "Sin actualizar";
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
