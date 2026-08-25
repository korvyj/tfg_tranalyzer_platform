const SID = document.body.dataset.sonda;
const REFRESH_MS = 5000;
let cfgTouched = false;
let lastRecent = [];
let lastGen = null;
let uptimeBase = null;
let uptimeAt = null;
const trendHist = new Map();
let sortKey = "ts", sortDir = -1;
let pageSize = 50, page = 0;
// Definición única de los filtros de la tabla de flujos: clave del campo,
// id del <select>, etiqueta del chip y texto de la opción "todos".
const FILTERS = [
  { key: "country", id: "f-country", label: "País",         empty: "País: todos" },
  { key: "org",     id: "f-org",     label: "Organización", empty: "Organización: todas" },
  { key: "l4",      id: "f-l4",      label: "L4",           empty: "L4: todos" },
  { key: "proto",   id: "f-proto",   label: "Protocolo",    empty: "Protocolo: todos" },
  { key: "service", id: "f-service", label: "Aplicación",   empty: "Aplicación: todas" },
];
const filters = Object.fromEntries(FILTERS.map((f) => [f.key, ""]));
let ipRecent = [];
let shownFlows = [];
let lastD = null;
let probeOnline = true;
// Ruta de la API de esta sonda.
const api = (path) => `/api/sonda/${encodeURIComponent(SID)}${path}`;

const PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff", "#39c5cf", "#ff7b72"];

let tsData = null;
const tsHidden = new Set();
let tsZoom = null;
let chartGeom = null;
let brush = null;

function fmtDuration(sec) {
  if (sec === null || sec === undefined || sec < 0) return "—";
  sec = Math.round(sec);
  if (sec < 60) return `${sec} s`;
  if (sec < 3600) return `${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
  return `${Math.floor(sec / 86400)} d ${Math.floor((sec % 86400) / 3600)} h`;
}

function fmtTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString("es");
}

function fmtFlowDur(sec) {
  if (sec === null || sec === undefined || sec < 0) return "—";
  if (sec < 1) return Math.round(sec * 1000) + " ms";
  if (sec < 60) return sec.toFixed(2) + " s";
  return fmtDuration(sec);
}

function fmtAgo(sec) {
  if (sec === null || sec === undefined) return "";
  sec = Math.max(0, Math.round(sec));
  if (sec < 2) return "ahora mismo";
  if (sec < 60) return `hace ${sec} s`;
  if (sec < 3600) return `hace ${Math.round(sec / 60)} min`;
  return `hace ${Math.round(sec / 3600)} h`;
}

function setNum(el, text) {
  if (!el) return;
  if (el.textContent === text) return;
  el.textContent = text;
  el.classList.remove("bump");
  void el.offsetWidth;
  el.classList.add("bump");
}

function setCount(el, value) {
  if (!el) return;
  const target = Number(value) || 0;
  const prev = el.dataset.val !== undefined ? Number(el.dataset.val) : target;
  el.dataset.val = String(target);
  if (prev === target) { el.textContent = nfmt(target); return; }
  el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
  const dur = 500, t0 = performance.now();
  function step(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = nfmt(Math.round(prev + (target - prev) * eased));
    if (p < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function trend(key, value) {
  const now = Date.now() / 1000;
  let hist = trendHist.get(key);
  if (!hist) { hist = []; trendHist.set(key, hist); }
  hist.push({ t: now, v: value });
  while (hist.length && hist[0].t < now - 75) hist.shift();
  const old = hist.find((s) => s.t <= now - 45);
  if (!old || old.v === value) return old ? { pct: 0, dir: "flat" } : null;
  if (old.v === 0) return { pct: null, dir: value > 0 ? "up" : "flat" };
  const pct = ((value - old.v) / old.v) * 100;
  return { pct, dir: pct > 0 ? "up" : (pct < 0 ? "down" : "flat") };
}

function renderTrend(id, tr) {
  const el = $("#" + id);
  if (!el) return;
  if (!tr || tr.dir === "flat") { el.textContent = ""; el.className = "strend"; return; }
  const arrow = tr.dir === "up" ? "▲" : "▼";
  const pct = tr.pct === null ? "" : ` ${Math.abs(tr.pct).toFixed(0)}%`;
  el.textContent = `${arrow}${pct}`;
  el.className = "strend " + tr.dir;
}

const esc = (v) =>
  String(v ?? "—").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const icon = (name) => `<svg class="ic"><use href="#ic-${name}"/></svg>`;

function windowVal() {
  return $("#window") ? $("#window").value : "300";
}

function toast(message, type = "info", timeout = 4500) {
  const box = $("#toasts");
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = message;
  el.addEventListener("click", () => el.remove());
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  if (timeout) setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 300); }, timeout);
}

// Celdas de barra + recuento, comunes a todas las tablas de "top valores".
const barCells = (count, max, cls = "") =>
  `<td class="barcell"><span class="bar${cls}" style="width:${max ? Math.round((count / max) * 100) : 0}%"></span></td>
   <td class="num">${nfmt(count)}</td>`;

// Pinta una tabla de barras; 'row(item, max)' aporta el <tr>. Devuelve el
// tbody (null si no había datos) para que quien llame enganche los clics.
function fillBarTable(tbodySel, items, row, emptyCls = "muted") {
  const tbody = $(tbodySel);
  if (!tbody) return null;
  if (!items || !items.length) {
    tbody.innerHTML = `<tr><td class="${emptyCls}">Sin datos</td></tr>`;
    return null;
  }
  const max = Math.max(...items.map((i) => i.count));
  tbody.innerHTML = items.map((i) => row(i, max)).join("");
  return tbody;
}

function fillBars(id, items, filterKey) {
  const isNdpi = id === "t-ndpi";
  const tbody = fillBarTable(`#${id} tbody`, items, (i, max) => {
    const val = esc(i.value);
    const unknown = /^unknown$/i.test(String(i.value ?? ""));
    const infoMark = (unknown && isNdpi)
      ? ` <span class="info-mark" title="Tráfico cifrado o no reconocido por nDPI (p. ej. TLS sin SNI). No es un error del sistema.">${icon("info")}</span>` : "";
    return `<tr class="${unknown ? "warn-row" : ""}${filterKey ? " clickable" : ""}" data-val="${val}"${filterKey ? ' title="Filtrar la tabla por este valor"' : ""}>
        <td class="lbl">${unknown ? icon("alert") + " " : ""}${val}${infoMark}</td>
        ${barCells(i.count, max, unknown ? " warn" : "")}
      </tr>`;
  });
  if (tbody && filterKey) {
    tbody.querySelectorAll("tr.clickable").forEach((tr) =>
      tr.addEventListener("click", () => {
        const v = tr.dataset.val;
        setFilter(filterKey, filterKey === "proto" ? v.split(".")[0] : v);
      }));
  }
}

function setFilter(key, val) {
  filters[key] = val;
  page = 0;
  flashTableDim();
  syncFilterSelects();
  renderActiveFilters();
  renderRecent();
  $("#t-recent").scrollIntoView({ behavior: "smooth", block: "center" });
}

function cmpBy(a, b, key) {
  if (key === "ts" || key === "dport") return (Number(a[key]) || 0) - (Number(b[key]) || 0);
  return String(a[key] ?? "").localeCompare(String(b[key] ?? ""), "es", { numeric: true });
}

function updateSortIndicators() {
  $$("#t-recent thead th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === sortKey;
    th.classList.toggle("sorted", active);
    th.dataset.dir = active ? (sortDir < 0 ? "desc" : "asc") : "";
  });
}

function fillSelect(id, values, current, label) {
  const sel = $("#" + id);
  if (document.activeElement === sel) return;
  if (current && !values.includes(current)) values = [current, ...values];
  sel.innerHTML = `<option value="">${label}</option>` +
    values.map((v) => `<option value="${esc(v)}"${v === current ? " selected" : ""}>${esc(v)}</option>`).join("");
  sel.value = current;
}

function populateFilterOptions() {
  const uniq = (key) => [...new Set(
    lastRecent.map((f) => f[key]).filter((v) => v !== null && v !== undefined && v !== "")
  )].map(String).sort((a, b) => a.localeCompare(b, "es", { numeric: true }));
  FILTERS.forEach((f) => fillSelect(f.id, uniq(f.key), filters[f.key], f.empty));
}

function populateIpDatalist() {
  const set = new Set();
  for (const f of lastRecent) { if (f.src) set.add(f.src); if (f.dst) set.add(f.dst); }
  $("#ip-list").innerHTML =
    [...set].slice(0, 200).map((ip) => `<option value="${esc(ip)}">`).join("");
}

function syncFilterSelects() {
  FILTERS.forEach((f) => { $("#" + f.id).value = filters[f.key]; });
}

function renderActiveFilters() {
  const box = $("#active-filters");
  const active = FILTERS.filter((f) => filters[f.key]);
  const text = ($("#recent-filter").value || "").trim();
  if (!active.length && !text) { box.innerHTML = ""; box.hidden = true; return; }
  box.hidden = false;
  let chips = active.map((f) =>
    `<span class="fchip" data-key="${f.key}">${f.label}: ${esc(filters[f.key])} <b>✕</b></span>`).join("");
  if (text) chips += `<span class="fchip" data-key="__text">Texto: ${esc(text)} <b>✕</b></span>`;
  box.innerHTML = `<span class="muted small">Filtros activos:</span> ${chips}`;
  box.querySelectorAll(".fchip").forEach((c) =>
    c.addEventListener("click", () => {
      const k = c.dataset.key;
      if (k === "__text") $("#recent-filter").value = "";
      else filters[k] = "";
      page = 0;
      syncFilterSelects();
      renderActiveFilters();
      renderRecent();
    }));
}

function clearAllFilters() {
  FILTERS.forEach((f) => { filters[f.key] = ""; });
  $("#recent-filter").value = "";
  page = 0;
  syncFilterSelects();
  renderActiveFilters();
  renderRecent();
}

function renderRecent() {
  const tbody = $("#t-recent tbody");
  const q = ($("#recent-filter").value || "").trim().toLowerCase();
  let items = lastRecent.slice();
  for (const { key } of FILTERS) {
    if (filters[key]) items = items.filter((f) => String(f[key] ?? "") === filters[key]);
  }
  if (q) {
    items = items.filter((f) =>
      [f.src, f.dst, f.dport, f.l4, f.proto, f.service, f.org, f.country]
        .some((v) => String(v ?? "").toLowerCase().includes(q)));
  }
  items.sort((a, b) => cmpBy(a, b, sortKey) * sortDir);
  updateSortIndicators();
  shownFlows = items;

  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (page >= pages) page = pages - 1;
  if (page < 0) page = 0;
  const start = page * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  const info = $("#pg-info");
  const prev = $("#pg-prev");
  const next = $("#pg-next");
  if (info) info.textContent = total ? `${start + 1}–${start + pageItems.length} de ${total}` : "0 de 0";
  if (prev) prev.disabled = page <= 0;
  if (next) next.disabled = page >= pages - 1;

  if (!total) {
    tbody.innerHTML = '<tr><td colspan="9" class="muted">Sin flujos que mostrar.</td></tr>';
    return;
  }
  tbody.innerHTML = pageItems
    .map((f, i) => {
      const idx = start + i;
      const unknown = /^unknown$/i.test(String(f.proto ?? ""));
      return `<tr class="frow ${unknown ? "warn-row" : ""}" data-idx="${idx}" title="Ver detalle del flujo">
      <td>${fmtTime(f.ts)}</td>
      <td class="mono ipcell" data-ip="${esc(f.src)}">${esc(f.src)}</td>
      <td class="mono ipcell" data-ip="${esc(f.dst)}">${esc(f.dst)}</td>
      <td>${esc(f.dport)}</td>
      <td>${esc(f.l4)}</td>
      <td>${unknown ? icon("alert") + " " : ""}${esc(f.proto)}</td>
      <td>${esc(f.service)}</td>
      <td>${esc(f.org)}</td>
      <td>${esc(f.country)}</td>
    </tr>`;
    })
    .join("");
  tbody.querySelectorAll("tr.frow").forEach((tr) =>
    tr.addEventListener("click", (e) => {
      if (e.target.closest(".ipcell")) return;
      openFlowDetails(shownFlows[Number(tr.dataset.idx)]);
    }));
  tbody.querySelectorAll(".ipcell").forEach((td) =>
    td.addEventListener("click", (e) => { e.stopPropagation(); lookupIp(td.dataset.ip); }));
}

function setBadge(el, on, onText, offText) {
  el.textContent = on ? onText : offText;
  el.className = "badge " + (on ? "on" : "off");
}

function setDot(el, on) {
  if (!el) return;
  el.className = "dot " + (on ? "ok" : "bad");
  el.title = on ? "sí" : "no";
}

function fillInfo(d) {
  const info = d.info || {};
  const cfg = info.config || {};

  setDot($("#i-online"), d.online);
  setDot($("#i-cap"), d.capturing);
  $("#i-iface").textContent = info.iface || "—";
  $("#i-flows").textContent = nfmt(d.flows);

  const ipBox = $("#i-ips");
  const ips = info.ips || [];
  ipBox.innerHTML = ips.length
    ? ips.map((ip) => `<span class="ipbadge mono">${esc(ip)}</span>`).join("")
    : "—";
  $("#i-os").textContent = info.os || "—";

  $("#i-mhost").textContent = cfg.MONGO_HOST || "—";
  $("#i-mport").textContent = cfg.MONGO_PORT || "—";
  $("#i-mdb").textContent = cfg.MONGO_DBNAME || "—";
  $("#i-mtable").textContent = cfg.MONGO_TABLE_NAME || "—";

  $("#foot-version").textContent = "Tranalyzer " +
    ((info.version || "").replace(/^Tranalyzer\s*/i, "") || "—");

  const sel = $("#iface-sel");
  const ifaces = info.interfaces && info.interfaces.length ? info.interfaces : (info.iface ? [info.iface] : []);
  const prev = sel.value;
  sel.innerHTML = ifaces
    .map((n) => `<option value="${esc(n)}">${esc(n)}</option>`)
    .join("") || '<option value="">(sin datos)</option>';
  sel.value = prev && ifaces.includes(prev) ? prev : (info.iface || ifaces[0] || "");

  const hasIfaces = ifaces.length > 0;
  sel.disabled = !hasIfaces;
  const ifaceBtn = $('.btn[data-action="set_interface"]');
  if (ifaceBtn && !opBusy) ifaceBtn.disabled = !hasIfaces;

  if (!cfgTouched && cfg) {
    const f = $("#cfg-form");
    CFG_KEYS.forEach((k) => {
      if (f.elements[k] && document.activeElement !== f.elements[k]) {
        f.elements[k].value = cfg[k] || "";
      }
    });
  }
}

function fillHeroAndCards(d) {

  const dot = $("#hero-dot");
  dot.className = "status-dot " + (d.online ? "ok" : "bad");
  $("#hero-status").textContent = d.online ? "SONDA ONLINE" : "SONDA OFFLINE";
  $("#hero-iface").textContent = (d.info && d.info.iface) || "—";
  const cap = $("#hero-cap");
  setBadge(cap, d.capturing, "Capturando", "Parada");
  cap.className = "cap-badge " + (d.capturing ? "on" : "off");
  setCount($("#hero-flows"), d.flows);

  setCount($("#k-lastmin"), d.flows_window);
  setNum($("#k-last"), fmtLastSeen(d.last_seen_s));
  const period = (d.first_ts && d.last_ts) ? d.last_ts - d.first_ts : null;
  setNum($("#k-period"), fmtDuration(period));

  const s = d.summary || {};
  const cards = [
    ["s-flows", "tr-flows", d.flows],
    ["s-ips", "tr-ips", s.unique_ips],
    ["s-countries", "tr-countries", s.countries],
    ["s-protocols", "tr-protocols", s.protocols],
    ["s-orgs", "tr-orgs", s.orgs],
  ];
  for (const [vid, tid, val] of cards) {
    setCount($("#" + vid), val);
    renderTrend(tid, trend(vid, val || 0));
  }
}

function updateControlState(d) {
  if (opBusy || !d) return;
  const cap = !!d.capturing, flows = d.flows || 0;
  const set = (sel, dis) => { const b = $(sel); if (b) b.disabled = dis; };
  set(".btn-start", cap);
  set(".btn-stop", !cap);
  set(".btn-restart", !cap);
  set(".btn-purge", flows === 0);

}

function tick() {
  if (lastGen !== null) {
    $("#updated").textContent =
      "Actualizado " + fmtAgo(Date.now() / 1000 - lastGen);
  }
  const badge = $("#uptime-badge");
  if (uptimeBase !== null && uptimeAt !== null) {
    const up = uptimeBase + (Date.now() / 1000 - uptimeAt);
    badge.innerHTML = icon("clock") + " " + (uptimeBase > 0 ? "Capturando: " + fmtDuration(up) : "Sin capturar");
    badge.className = "uptime-badge " + (uptimeBase > 0 ? "on" : "off");
  }

  const hd = $("#hdr-dot");
  if (hd) {
    const state = !probeOnline ? "off" : (uptimeBase > 0 ? "ok" : "warn");
    hd.className = "hdr-dot " + state;
    hd.title = state === "ok" ? "Capturando" : state === "warn" ? "Online, parada" : "Sin conexión";
  }
}

function niceMax(v) {
  if (v <= 1) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

function resetChartView() { tsZoom = null; tsHidden.clear(); }

async function refreshChart() {
  const by = $("#ts-by").value;
  const win = $("#ts-window").value;
  try {
    const res = await fetch(api(`/timeseries?by=${by}&window=${win}&buckets=30`));
    tsData = await res.json();
    renderChart();
    renderTalkers(tsData);
  } catch (e) {
    $("#ts-chart").innerHTML = '<span class="muted">Error al cargar la gráfica.</span>';
  }
}

function renderTalkers(d) {
  const fill = (id, items) => {
    const tbody = fillBarTable(`#${id} tbody`, items, (i, max) =>
      `<tr class="clickable" data-ip="${esc(i.value)}" title="Investigar ${esc(i.value)}">
        <td class="lbl mono">${esc(i.value)}</td>
        ${barCells(i.count, max)}
      </tr>`, "muted small");
    if (tbody) {
      tbody.querySelectorAll("tr.clickable").forEach((tr) =>
        tr.addEventListener("click", () => { showTab("analisis"); lookupIp(tr.dataset.ip); }));
    }
  };
  fill("top-src", d && d.top_src);
  fill("top-dst", d && d.top_dst);
}

function renderChart() {
  const d = tsData;
  const host = $("#ts-chart");
  const legend = $("#ts-legend");
  if (!d || !(d.series || []).length) {
    host.innerHTML = '<span class="muted">Sin datos.</span>'; legend.innerHTML = "";
    chartGeom = null; $("#ts-reset").hidden = true; return;
  }
  const all = d.series;
  const i0 = tsZoom ? Math.max(0, tsZoom.i0) : 0;
  const i1 = tsZoom ? Math.min(all.length - 1, tsZoom.i1) : all.length - 1;
  const vis = all.slice(i0, i1 + 1);
  const isTotal = d.by === "total";
  const allKeys = isTotal ? ["total"] : (d.keys || []);
  const keys = allKeys.filter((k) => !tsHidden.has(k));
  const valOf = (b, k) => isTotal ? b.total : (b.counts[k] || 0);

  const W = 820, H = 240, pad = { l: 46, r: 12, t: 12, b: 26 };

  const anyData = vis.some((b) => b.total > 0);
  if (!anyData) {
    const msg = probeOnline ? "Sin datos en esta ventana" : "Sin datos — la sonda está desconectada";
    host.innerHTML =
      `<svg viewBox="0 0 ${W} ${H}" class="tsvg" role="img" aria-label="Sin datos">
        <rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="none" stroke="var(--line)" class="grid faint"/>
        <text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="ts-empty">${esc(msg)}</text>
      </svg>`;
    legend.innerHTML = "";
    chartGeom = null;
    $("#ts-reset").hidden = !tsZoom;
    return;
  }

  let maxY = 0;
  for (const b of vis) for (const k of keys) maxY = Math.max(maxY, valOf(b, k));
  maxY = niceMax(maxY || 1);

  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b, n = vis.length;
  const x = (i) => pad.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const y = (v) => pad.t + ih - (v / maxY) * ih;

  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const t = Math.round(maxY * f);
    return `<line x1="${pad.l}" y1="${y(t)}" x2="${W - pad.r}" y2="${y(t)}" class="grid"/>` +
      `<text x="${pad.l - 6}" y="${y(t) + 3}" class="yl">${nfmt(t)}</text>`;
  }).join("");

  const tl = (i) => new Date(vis[i].t * 1000).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const xlab = [0, Math.floor(n / 2), n - 1].map((i) =>
    `<text x="${x(i)}" y="${H - 8}" class="xl" text-anchor="middle">${tl(i)}</text>`).join("");

  let paths = "";
  keys.forEach((k) => {
    const ki = allKeys.indexOf(k);
    const col = isTotal ? "#58a6ff" : PALETTE[ki % PALETTE.length];
    const line = "M" + vis.map((b, i) => `${x(i).toFixed(1)},${y(valOf(b, k)).toFixed(1)}`).join(" L");
    if (isTotal) paths += `<path d="${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z" fill="url(#tgrad)"/>`;
    paths += `<path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
  });

  host.innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="tsvg" role="img" aria-label="Evolución temporal">
      <defs><linearGradient id="tgrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#58a6ff" stop-opacity="0.45"/>
        <stop offset="100%" stop-color="#58a6ff" stop-opacity="0"/>
      </linearGradient></defs>${grid}${paths}${xlab}
      <line id="ts-cursor" class="ts-cursor" x1="0" y1="${pad.t}" x2="0" y2="${pad.t + ih}" style="visibility:hidden"/>
      <rect id="ts-brush" class="ts-brush" x="0" y="${pad.t}" width="0" height="${ih}" style="visibility:hidden"/>
    </svg>`;

  chartGeom = { W, pad, ih, n, i0, vis, keys, allKeys, valOf, isTotal, x, y, d };
  renderChartLegend(d, allKeys);
  $("#ts-reset").hidden = !tsZoom;
}

function renderChartLegend(d, allKeys) {
  const legend = $("#ts-legend");
  if (d.by === "total") {
    legend.innerHTML = `<span class="lg"><span class="sw" style="background:#58a6ff"></span>Flujos totales</span>`;
    return;
  }
  if (!allKeys.length) { legend.innerHTML = '<span class="muted small">Sin series en esta ventana.</span>'; return; }
  legend.innerHTML = allKeys.map((k, ki) =>
    `<span class="lg${tsHidden.has(k) ? " off" : ""}" data-key="${esc(k)}" title="Mostrar/ocultar">` +
    `<span class="sw" style="background:${PALETTE[ki % PALETTE.length]}"></span>${esc(k)}</span>`).join("");
  legend.querySelectorAll(".lg").forEach((el) =>
    el.addEventListener("click", () => {
      const k = el.dataset.key;
      if (tsHidden.has(k)) tsHidden.delete(k); else tsHidden.add(k);
      renderChart();
    }));
}

function chartLocalIndex(ev) {
  const g = chartGeom; if (!g) return null;
  const r = $("#ts-chart").getBoundingClientRect();
  const px = (ev.clientX - r.left) / r.width;
  const plotL = g.pad.l / g.W, plotR = (g.W - g.pad.r) / g.W;
  let t = (px - plotL) / (plotR - plotL);
  t = Math.max(0, Math.min(1, t));
  return Math.round(t * (g.n - 1));
}

function onChartMove(ev) {
  const g = chartGeom; if (!g) return;
  const iLocal = chartLocalIndex(ev);
  if (iLocal === null) return;
  const b = g.vis[iLocal]; if (!b) return;

  const cur = $("#ts-cursor");
  if (cur) { const xx = g.x(iLocal); cur.setAttribute("x1", xx); cur.setAttribute("x2", xx); cur.style.visibility = "visible"; }

  if (brush) {
    const rect = $("#ts-brush");
    if (rect) {
      const a = Math.min(brush.start, iLocal), c = Math.max(brush.start, iLocal);
      rect.setAttribute("x", g.x(a)); rect.setAttribute("width", Math.max(0, g.x(c) - g.x(a)));
      rect.style.visibility = "visible";
    }
    brush.cur = iLocal;
  }

  const tip = $("#ts-tip");
  const time = new Date(b.t * 1000).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  let rows;
  if (g.isTotal) {
    rows = `<div><span class="sw" style="background:#58a6ff"></span>Flujos: <b>${nfmt(b.total)}</b></div>`;
  } else {
    rows = g.keys.map((k) => {
      const ki = g.allKeys.indexOf(k);
      return `<div><span class="sw" style="background:${PALETTE[ki % PALETTE.length]}"></span>${esc(k)}: <b>${nfmt(b.counts[k] || 0)}</b></div>`;
    }).join("") + `<div class="muted">Total: ${nfmt(b.total)}</div>`;
  }
  tip.innerHTML = `<div class="tt-time">${time}</div>${rows}`;
  tip.hidden = false;
  const wrap = $(".ts-wrap").getBoundingClientRect();
  let left = ev.clientX - wrap.left + 14;
  if (left > wrap.width - 150) left = ev.clientX - wrap.left - 150;
  tip.style.left = Math.max(0, left) + "px";
  tip.style.top = Math.max(0, ev.clientY - wrap.top + 12) + "px";
}

function onChartLeave() {
  const tip = $("#ts-tip"); if (tip) tip.hidden = true;
  const cur = $("#ts-cursor"); if (cur) cur.style.visibility = "hidden";
}

function onChartDown(ev) {
  const iLocal = chartLocalIndex(ev);
  if (iLocal === null) return;
  brush = { start: iLocal, cur: iLocal };
  ev.preventDefault();
}

function onChartUp() {
  if (!brush) return;
  const g = chartGeom;
  const a = Math.min(brush.start, brush.cur), c = Math.max(brush.start, brush.cur);
  const rect = $("#ts-brush"); if (rect) rect.style.visibility = "hidden";
  const dragged = brush; brush = null;
  if (g && c - a >= 2) { tsZoom = { i0: g.i0 + a, i1: g.i0 + c }; renderChart(); }
}

function loadRecentSearches() {
  try { ipRecent = JSON.parse(localStorage.getItem("ipRecent_" + SID) || "[]"); }
  catch (e) { ipRecent = []; }
}

function addRecentSearch(ip) {
  ip = (ip || "").trim();
  if (!ip) return;
  ipRecent = [ip, ...ipRecent.filter((x) => x !== ip)].slice(0, 8);
  try { localStorage.setItem("ipRecent_" + SID, JSON.stringify(ipRecent)); } catch (e) {}
  renderRecentSearches();
}

function renderRecentSearches() {
  const box = $("#ip-recent");
  box.innerHTML = ipRecent.length
    ? ipRecent.map((ip) => `<button class="chip mono" data-ip="${esc(ip)}">${esc(ip)}</button>`).join("")
    : '<span class="muted small">ninguna todavía</span>';
  box.querySelectorAll(".chip").forEach((b) =>
    b.addEventListener("click", () => lookupIp(b.dataset.ip)));
}

function ipList(title, items, ipClickable) {
  if (!items || !items.length) return "";
  return `<div class="ipl"><h4>${title}</h4><ul>` +
    items.map((i) => {
      const label = ipClickable
        ? `<a class="peer-ip mono" data-ip="${esc(i.value)}">${esc(i.value)}</a>`
        : esc(i.value);
      return `<li>${label} <span class="muted">${nfmt(i.count)}</span></li>`;
    }).join("") +
    `</ul></div>`;
}

async function lookupIp(ip) {
  ip = (ip || "").trim();
  if (!ip) return;
  $("#ip-input").value = ip;
  addRecentSearch(ip);
  const box = $("#ip-result");
  box.hidden = false;
  $("#ip-clear").hidden = false;
  box.innerHTML = '<span class="muted">Buscando…</span>';
  try {
    const res = await fetch(api(`/ip?ip=${encodeURIComponent(ip)}`));
    const d = await res.json();
    if (d.error) { box.innerHTML = `<span class="error">${esc(d.error)}</span>`; return; }
    if (!d.flows) { box.innerHTML = `<p class="muted">Sin flujos para <span class="mono">${esc(ip)}</span>.</p>`; return; }
    box.innerHTML = `
      <p><b class="mono">${esc(ip)}</b> — ${nfmt(d.flows)} flujos
         (${nfmt(d.as_src)} como origen, ${nfmt(d.as_dst)} como destino)</p>
      <div class="ipl-grid">
        ${ipList(icon("tag") + " Protocolos", d.protocols)}
        ${ipList(icon("globe") + " Países", d.countries)}
        ${ipList(icon("building") + " Organizaciones", d.orgs)}
        ${ipList(icon("plug") + " Servicio por puerto", d.ports)}
        ${ipList(icon("link") + " Pares (peers)", d.peers, true)}
      </div>`;

    box.querySelectorAll(".peer-ip").forEach((a) =>
      a.addEventListener("click", () => lookupIp(a.dataset.ip)));
  } catch (e) {
    box.innerHTML = `<span class="error">Error de red: ${esc(e)}</span>`;
  }
}

function fmtBytes(n) {
  if (n === null || n === undefined) return "—";
  n = Number(n);
  if (n < 1024) return n + " B";
  if (n < 1048576) return (n / 1024).toFixed(1) + " KB";
  return (n / 1048576).toFixed(2) + " MB";
}

function drawerRow(k, v) {
  const val = (v === null || v === undefined || v === "") ? "—" : v;
  return `<dt>${k}</dt><dd class="mono">${esc(val)}</dd>`;
}

function openFlowDetails(f) {
  if (!f) return;
  const body = $("#drawer-body");
  const bytes = (f.bytes_snt != null || f.bytes_rcvd != null)
    ? `${fmtBytes(f.bytes_snt)} ↑ / ${fmtBytes(f.bytes_rcvd)} ↓` : "—";
  const pkts = (f.pkts_snt != null || f.pkts_rcvd != null)
    ? `${nfmt(f.pkts_snt)} ↑ / ${nfmt(f.pkts_rcvd)} ↓` : "—";
  const l7 = [f.proto, f.service].filter(Boolean).join(" · ") || "—";
  const dur = (f.ts != null && f.ts_first != null) ? fmtFlowDur(f.ts - f.ts_first) : "—";
  const total_pkts = (f.pkts_snt || 0) + (f.pkts_rcvd || 0);
  const total_bytes = (f.bytes_snt || 0) + (f.bytes_rcvd || 0);
  body.innerHTML =
    `<dl class="drawer-dl">
      ${drawerRow("Hora (fin)", f.ts ? new Date(f.ts * 1000).toLocaleString("es") : "—")}
      ${drawerRow("Hora (inicio)", f.ts_first ? new Date(f.ts_first * 1000).toLocaleString("es") : "—")}
      ${drawerRow("Duración", dur)}
      ${drawerRow("IP origen", f.src)}
      ${drawerRow("Puerto origen", f.sport)}
      ${drawerRow("IP destino", f.dst)}
      ${drawerRow("Puerto destino", f.dport)}
      ${drawerRow("Clase de puerto", f.port_class)}
      ${drawerRow("Protocolo L4", f.l4)}
      ${drawerRow("Protocolo L7", l7)}
      ${drawerRow("Organización", f.org)}
      ${drawerRow("País", f.country)}
      ${drawerRow("Paquetes (env/rec)", pkts)}
      ${drawerRow("Paquetes (total)", nfmt(total_pkts))}
      ${drawerRow("Bytes L7 (env/rec)", bytes)}
      ${drawerRow("Bytes L7 (total)", fmtBytes(total_bytes))}
    </dl>
    <details class="collapse subcollapse" id="flow-meta">
      <summary>📋 Metadatos completos (Tranalyzer)</summary>
      <div id="flow-meta-body"><span class="muted small">Despliega para cargar todos los campos…</span></div>
    </details>
    <div class="drawer-actions">
      <button class="btn btn-iface small" id="drawer-ip-src">${icon("search")} Investigar origen</button>
      <button class="btn btn-iface small" id="drawer-ip-dst">${icon("search")} Investigar destino</button>
    </div>`;
  const drill = (ip) => { closeDrawer(); lookupIp(ip); $(".ip-panel").scrollIntoView({ behavior: "smooth", block: "center" }); };
  const bs = $("#drawer-ip-src"); if (bs && f.src) bs.addEventListener("click", () => drill(f.src));
  const bd = $("#drawer-ip-dst"); if (bd && f.dst) bd.addEventListener("click", () => drill(f.dst));

  const det = $("#flow-meta");
  det.addEventListener("toggle", () => { if (det.open) loadFlowMeta(f.id); });
  openDrawer();
}

async function loadFlowMeta(id) {
  const box = $("#flow-meta-body");
  if (!box) return;
  if (!id) { box.innerHTML = '<span class="muted small">Sin id de flujo disponible.</span>'; return; }
  if (box.dataset.loaded === id) return;
  box.innerHTML = '<span class="muted small">Cargando…</span>';
  try {
    const res = await fetch(api(`/flow/${encodeURIComponent(id)}`));
    const d = await res.json();
    if (d._error) { box.innerHTML = `<span class="error">${esc(d._error)}</span>`; return; }
    const f = d.fields || {};
    const keys = Object.keys(f).filter((k) => k !== "_id").sort();
    box.innerHTML = `<table class="meta-table"><tbody>` +
      keys.map((k) => `<tr><td class="mono muted">${esc(k)}</td><td class="mono">${esc(f[k])}</td></tr>`).join("") +
      `</tbody></table>`;
    box.dataset.loaded = id;
  } catch (e) {
    box.innerHTML = `<span class="error">Error de red: ${esc(e)}</span>`;
  }
}

function openDrawer() {
  $("#drawer-overlay").hidden = false;
  const dr = $("#flow-drawer");
  dr.hidden = false;
  requestAnimationFrame(() => dr.classList.add("open"));
}

function closeDrawer() {
  const dr = $("#flow-drawer");
  if (dr.hidden) return;
  dr.classList.remove("open");
  $("#drawer-overlay").hidden = true;
  setTimeout(() => { dr.hidden = true; }, 250);
}

async function refresh() {
  try {
    const res = await fetch(api(`?window=${windowVal()}`));
    const d = await res.json();

    lastD = d;
    probeOnline = !!d.online;
    fillHeroAndCards(d);
    fillInfo(d);
    fillBars("t-ndpi", d.ndpi, "proto");
    fillBars("t-orgs", d.orgs, "org");
    fillBars("t-countries", d.countries, "country");
    fillBars("t-ports", d.ports);
    updateControlState(d);

    lastRecent = d.recent || [];
    populateFilterOptions();
    populateIpDatalist();
    renderActiveFilters();
    renderRecent();

    const banners = [];
    const e = d.errors || {};
    if (!d.online || e.info) {
      let msg = "La sonda no responde";
      if (d.last_seen_s != null) {
        msg += `. Último contacto hace ${fmtLastSeen(d.last_seen_s)}`;
        if (d.last_ts) msg += ` (${new Date(d.last_ts * 1000).toLocaleString("es")})`;
        msg += ".";
      } else {
        msg += " y no ha enviado datos todavía.";
      }
      banners.push(msg);
    }
    if (e.mongo) banners.push(`Base de datos no disponible: ${e.mongo}`);
    $("#errors").innerHTML = banners
      .map((m) => `<span class="error">${icon("alert")} ${esc(m)}</span>`)
      .join(" ");

    lastGen = d.generated_at || (Date.now() / 1000);
    const up = d.info && typeof d.info.uptime_s === "number" ? d.info.uptime_s : null;
    if (up !== null) { uptimeBase = up; uptimeAt = Date.now() / 1000; }
    tick();
  } catch (e) {
    $("#updated").textContent = "error al actualizar";
  }
}

let opBusy = false;

function setBusy(busy, btn) {
  opBusy = busy;
  $$('.btn[data-action], #btn-clear, #cfg-form button[type="submit"]')
    .forEach((b) => { b.disabled = busy; });
  $$(".btn.loading").forEach((b) => b.classList.remove("loading"));
  if (busy && btn) btn.classList.add("loading");
  if (!busy) updateControlState(lastD);
}

function flashTableDim() {
  const box = $(".table-scroll");
  if (!box) return;
  box.classList.add("filtering");
  setTimeout(() => box.classList.remove("filtering"), 180);
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

// Claves de sonda.env editables desde el panel (lista blanca del backend).
const CFG_KEYS = ["MONGO_HOST", "MONGO_PORT", "MONGO_DBNAME", "MONGO_TABLE_NAME"];

const OK_MSG = {
  start: "Tranalyzer iniciado correctamente.",
  stop: "Tranalyzer detenido.",
  restart: "Tranalyzer detenido.\nTranalyzer iniciado correctamente.",
  apply_config: "Configuración restablecida desde el pillar (captura reiniciada).",
  set_interface: (arg) => `Interfaz de captura cambiada a «${arg}».`,
};

// Esqueleto común de las operaciones sobre la sonda: bloquea los controles,
// lanza el POST, notifica el resultado y programa un refresco. 'okMsg' recibe
// la respuesta; 'failMsg' es el texto por defecto si la sonda responde mal.
async function runOp(btn, path, body, { okMsg, failMsg, delay = 800, done }) {
  setBusy(true, btn);
  try {
    const { data } = await post(api(path), body);
    if (data.ok) toast(okMsg(data), "ok");
    else toast("Error: " + (data.error || failMsg), "bad", 7000);
    if (done) done();
    setTimeout(refresh, delay);
  } catch (e) {
    toast("Error de red: " + e, "bad", 7000);
  } finally {
    setBusy(false);
  }
}

async function sendAction(action, btn) {
  if (opBusy) return;
  const body = { action };
  if (action === "set_interface") {
    body.iface = $("#iface-sel").value;
    if (!body.iface) return toast("No hay interfaz seleccionada.", "warn");
  }
  const m = OK_MSG[action];
  return runOp(btn, "/action", body, {
    okMsg: () => (typeof m === "function" ? m(body.iface) : (m || "Acción completada.")),
    failMsg: "acción fallida",
  });
}

async function saveConfig(ev) {
  ev.preventDefault();
  if (opBusy) return;
  const f = ev.target;
  const btn = ev.submitter || f.querySelector('button[type="submit"]');
  const cfg = {};
  CFG_KEYS.forEach((k) => {
    const v = f.elements[k].value.trim();
    if (v) cfg[k] = v;
  });
  return runOp(btn, "/config", { config: cfg }, {
    okMsg: () => "Configuración guardada y captura reiniciada.",
    failMsg: "config no aplicada",
    delay: 1000,
    done: () => { cfgTouched = false; },
  });
}

async function clearData(btn) {
  if (opBusy) return;
  if (!confirm(`¿Vaciar TODOS los flujos de ${SID} en MongoDB? Esta acción no se puede deshacer.`))
    return;
  return runOp(btn, "/clear", null, {
    okMsg: (data) => `Borrados ${nfmt(data.deleted)} flujos.`,
    failMsg: "no se pudo vaciar",
    delay: 500,
  });
}

$$(".btn[data-action]").forEach((b) =>
  b.addEventListener("click", () => sendAction(b.dataset.action, b))
);
$("#btn-clear").addEventListener("click", (e) => clearData(e.currentTarget));
$("#cfg-form").addEventListener("submit", saveConfig);
$("#cfg-form").addEventListener("input", () => { cfgTouched = true; });
$("#recent-filter").addEventListener("input", () => { page = 0; renderActiveFilters(); renderRecent(); });
$("#window").addEventListener("change", refresh);

$$("#t-recent thead th[data-sort]").forEach((th) =>
  th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (sortKey === k) sortDir = -sortDir;
    else { sortKey = k; sortDir = (k === "ts") ? -1 : 1; }
    page = 0;
    renderRecent();
  }));

FILTERS.forEach(({ id, key }) =>
  $("#" + id).addEventListener("change", (e) => {
    filters[key] = e.target.value;
    page = 0;
    flashTableDim();
    renderActiveFilters();
    renderRecent();
  }));
$("#f-clear").addEventListener("click", clearAllFilters);

$("#page-size").addEventListener("change", (e) => {
  pageSize = parseInt(e.target.value, 10) || 50;
  page = 0;
  renderRecent();
});
$("#pg-prev").addEventListener("click", () => { if (page > 0) { page--; renderRecent(); } });
$("#pg-next").addEventListener("click", () => { page++; renderRecent(); });

$("#ts-by").addEventListener("change", () => { resetChartView(); refreshChart(); });
$("#ts-window").addEventListener("change", () => { resetChartView(); refreshChart(); });
$("#ts-reset").addEventListener("click", () => { tsZoom = null; renderChart(); });

(function chartInteractions() {
  const host = $("#ts-chart");
  host.addEventListener("mousemove", onChartMove);
  host.addEventListener("mouseleave", onChartLeave);
  host.addEventListener("mousedown", onChartDown);
  window.addEventListener("mouseup", onChartUp);
})();

$("#drawer-close").addEventListener("click", closeDrawer);
$("#drawer-overlay").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

$("#ip-btn").addEventListener("click", () => lookupIp($("#ip-input").value));
$("#ip-input").addEventListener("keydown", (e) => { if (e.key === "Enter") lookupIp(e.target.value); });
$("#ip-clear").addEventListener("click", () => {
  $("#ip-input").value = "";
  const box = $("#ip-result");
  box.hidden = true; box.innerHTML = "";
  $("#ip-clear").hidden = true;
});

const TABS = ["resumen", "analisis", "config"];
function showTab(name) {
  if (!TABS.includes(name)) name = "resumen";
  TABS.forEach((t) => {
    $("#tab-" + t).hidden = (t !== name);
    $(`.tab[data-tab="${t}"]`).classList.toggle("active", t === name);
  });
  if (location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
  if (name === "resumen") refreshChart();
}
$$(".tab").forEach((b) =>
  b.addEventListener("click", () => showTab(b.dataset.tab)));
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

loadRecentSearches();
renderRecentSearches();
refresh();
showTab(location.hash.slice(1) || "resumen");
setInterval(refresh, REFRESH_MS);

setInterval(() => { if (!$("#tab-resumen").hidden) refreshChart(); }, 10000);
setInterval(tick, 1000);
