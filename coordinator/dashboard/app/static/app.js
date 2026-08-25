const REFRESH_MS = 5000;

function row(s) {
  const conn = s.online
    ? '<span class="dot ok"></span>online'
    : '<span class="dot bad"></span>offline';
  const cap = s.capturing
    ? '<span class="pill on">capturando</span>'
    : '<span class="pill off">parada</span>';
  return `<tr>
    <td><a href="/sonda/${encodeURIComponent(s.id)}">${s.id}</a></td>
    <td>${conn}</td>
    <td>${cap}</td>
    <td>${s.collection}</td>
    <td>${nfmt(s.flows)}</td>
    <td>${nfmt(s.flows_5m)}</td>
    <td>${fmtLastSeen(s.last_seen_s)}</td>
  </tr>`;
}

async function refresh() {
  try {
    const res = await fetch("/api/status");
    const data = await res.json();
    const tbody = $("#sondas tbody");
    tbody.innerHTML = data.sondas.length
      ? data.sondas.map(row).join("")
      : '<tr><td colspan="7" class="muted">Sin sondas registradas todavía.</td></tr>';
    const d = new Date(data.generated_at * 1000);
    $("#updated").textContent =
      "actualizado " + d.toLocaleTimeString("es");
  } catch (e) {
    $("#updated").textContent = "error al actualizar";
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
