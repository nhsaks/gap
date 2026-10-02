"use strict";
const $ = id => document.getElementById(id);
const normSym = s => String(s || "").toUpperCase().trim();

let lastSymKey = "";
let lastLogTop = "";

/* ---------- Formatters ---------- */
const fmtP = p => {
  if (p == null || !isFinite(p)) return "—";
  const d = p >= 100 ? 2 : p >= 1 ? 4 : p >= 0.001 ? 6 : 8;
  return p.toFixed(d);
};
const fmtN = n => {
  if (n == null || !isFinite(n)) return "—";
  if (Math.abs(n) < 1e-9) return "0";
  return n.toFixed(4).replace(/\.?0+$/, '');
};
const fmtSigned = n => (n >= 0 ? "+" : "") + fmtN(n);
const pad2 = n => String(n).padStart(2, "0");
const fmtTime = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
const fmtDur = ms => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
};
const fmtAge = ms => {
  if (ms < 1000) return Math.floor(ms) + "ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + "s";
  return Math.floor(ms / 60000) + "m";
};

/* ---------- API ---------- */
async function sendAction(action, payload = null) {
  try {
    await fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload }),
    });
    fetchState();
  } catch (e) { console.error("Action error:", e); }
}
async function fetchState() {
  try {
    const r = await fetch('/api/state');
    renderAll(await r.json());
  } catch (e) { console.error("Fetch error:", e); }
}

/* ---------- Render ---------- */
function syncInput(id, value) {
  const el = $(id);
  if (!el) return;
  if (document.activeElement === el) return;
  if (el.type === 'checkbox') el.checked = !!value;
  else if (String(el.value) !== String(value)) el.value = value;
}

function renderAll(s) {
  /* Session */
  $("sessStart").textContent = fmtTime(new Date(s.session.startTime));
  $("sessDur").textContent = fmtDur(s.session.duration);
  $("sessTrades").textContent = s.session.trades;
  $("sessWL").textContent = `${s.session.wins} / ${s.session.losses}`;
  $("sessFees").textContent = fmtN(s.session.feesPaid);
  const el = $("sessRealized");
  el.textContent = fmtSigned(s.session.realizedPnl);
  el.className = "big " + (s.session.realizedPnl > 0 ? "pos" : s.session.realizedPnl < 0 ? "neg" : "");

  /* Symbols */
  const key = s.settings.symbols.join(",") + "|" + s.settings.checked.join(",");
  if (key !== lastSymKey) { renderSymbols(s); lastSymKey = key; }
  $("symCount").textContent = `(${s.settings.checked.length}/${s.settings.symbols.length} checked)`;

  /* Trade setup */
  syncInput("autopilot", s.tradeSetup.autopilotOn);
  syncInput("gapFilter", s.tradeSetup.gapFilter);
  syncInput("longGap", s.tradeSetup.longGap);
  syncInput("shortGap", s.tradeSetup.shortGap);
  syncInput("maxOpen", s.tradeSetup.maxOpen);
  syncInput("sl", s.tradeSetup.sl);
  syncInput("amt", s.tradeSetup.amt);
  syncInput("fee", s.tradeSetup.fee);

  /* Connection */
  const cs = s.connStatus, dot = $("connDot"), txt = $("connTxt");
  if (cs.spot && cs.fut) { dot.className = "dot on"; txt.textContent = "Live (spot + futures)"; }
  else if (cs.spot || cs.fut) { dot.className = "dot wait"; txt.textContent = "Partial connection…"; }
  else { dot.className = "dot"; txt.textContent = "Connecting…"; }

  $("nPos").textContent = s.nPos;
  $("nQueue").textContent = s.nQueue;
  const gc = s.settings.symbols.filter(sym => s.prices.spot[normSym(sym)] && s.prices.fut[normSym(sym)]).length;
  $("gapCount").textContent = gc;

  const lastTick = Object.values(s.prices.tickAt).reduce((a, b) => Math.max(a, b || 0), 0);
  const age = lastTick ? Date.now() - lastTick : null;
  const laEl = $("lastTickAge");
  if (age == null) { laEl.textContent = "—"; laEl.className = ""; }
  else {
    laEl.textContent = fmtAge(age);
    laEl.className = age < 3000 ? "pos" : age < 10000 ? "" : "neg";
  }

  $("autoTxt").textContent = `leg +$0.05 / SL -$${fmtN(s.tradeSetup.sl)}`;

  renderTicker(s);
  renderTable(s);
  renderApBar(s);
  renderLogs(s);
}

function renderSymbols(s) {
  const row = $("symRow"); row.innerHTML = "";
  const checked = new Set(s.settings.checked.map(normSym));
  s.settings.symbols.forEach(sym => {
    const S = normSym(sym);
    const isChecked = checked.has(S);
    const lb = document.createElement("label");
    lb.className = "symbox" + (isChecked ? "" : " off");
    lb.innerHTML = `<input type="checkbox" ${isChecked ? "checked" : ""}> <span>${sym}</span>`;
    lb.querySelector("input").onchange = (e) =>
      sendAction("toggleSymbol", { symbol: S, isChecked: e.target.checked });
    const rm = document.createElement("button");
    rm.type = "button"; rm.className = "rm"; rm.textContent = "✕"; rm.title = "Remove " + sym;
    rm.onclick = (e) => { e.preventDefault(); e.stopPropagation(); sendAction("removeSymbol", { symbol: S }); };
    lb.appendChild(rm);
    row.appendChild(lb);
  });
}

function renderTicker(s) {
  $("ticker").innerHTML = s.settings.symbols.map(sym => {
    const S = normSym(sym);
    const sp = s.prices.spot[S], fu = s.prices.fut[S];
    const dim = s.settings.checked.includes(S) ? "" : "dim";
    if (sp == null || fu == null) return `<span class="${dim}">${sym}: …</span>`;
    const tick = s.prices.tickSizes[S] || 0.01;
    const tks = (fu - sp) / tick;
    const gapTxt = `<span class="${tks >= 0 ? "up" : "down"}" style="font-size:11px;">(${tks >= 0 ? "+" : ""}${tks.toFixed(1)}t)</span>`;
    return `<span class="${dim}">${sym} <b>${fmtP(fu)}</b> ${gapTxt}</span>`;
  }).join("");
}

function renderTable(s) {
  const tb = $("tbody"); tb.innerHTML = "";

  /* Open positions */
  s.positions.forEach(p => {
    const S = normSym(p.sym);
    const cur = s.prices.fut[S], sp = s.prices.spot[S];
    const tick = s.prices.tickSizes[S] || 0.01;
    const tks = (cur != null && sp != null && sp > 0) ? (cur - sp) / tick : null;
    const gp  = (cur != null && sp != null && sp > 0) ? ((cur - sp) / sp) * 100 : null;

    const gross = cur == null ? 0 : (p.side === "LONG" ? (cur - p.entry) * p.amt : (p.entry - cur) * p.amt);
    const net = gross - p.fees;
    const pct = (cur != null && p.entry > 0)
      ? ((p.side === "LONG" ? (cur - p.entry) : (p.entry - cur)) / p.entry) * 100 : null;

    const addsBadge = (p.adds && p.adds > 1) ? `<span class="badge adds">×${p.adds}</span>` : "";

    let gapCell = `<span style="color:var(--muted)">—</span>`;
    if (tks != null && gp != null) {
      const cls = tks >= 0 ? "neg" : "pos";
      gapCell = `<span class="${cls}" style="font-weight:bold;">${tks >= 0 ? "+" : ""}${tks.toFixed(1)}t</span>` +
                `<span class="sub">${gp >= 0 ? "+" : ""}${gp.toFixed(3)}%</span>`;
    }
    const idx = p.spot ?? sp;
    const entryCell = `
      ${fmtP(p.entry)}${pct != null ? `<span class="sub ${pct >= 0 ? "pos" : "neg"}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>` : ""}
      ${idx != null ? `<span class="sub" style="color:var(--muted)">idx ${fmtP(idx)}</span>` : ""}`;

    const notional = p.notional || (p.amt * p.entry);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${p.sym}</b>${addsBadge}</td>
      <td style="text-align:right;"><span class="badge ${p.side === "LONG" ? "l" : "s"}">${p.side}</span></td>
      <td>${entryCell}</td>
      <td><b>${fmtN(p.amt)}</b></td>
      <td style="color:var(--muted);">$${fmtN(notional)}${p.fees > 0 ? `<span class="sub">fee ${fmtN(p.fees)}</span>` : ""}</td>
      <td class="${net >= 0 ? "pos" : "neg"}" style="font-weight:bold;">${net >= 0 ? "+" : ""}${fmtN(net)}${pct != null ? `<span class="sub ${net >= 0 ? "pos" : "neg"}">${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%</span>` : ""}</td>
      <td>${gapCell}</td>
      <td><button class="btn ghost" style="padding:3px 9px;font-size:11px;" data-id="${p.id}">✕</button></td>`;
    tr.querySelector("button").onclick = () => sendAction("closePosition", { id: p.id });
    tb.appendChild(tr);
  });

  /* Queued */
  s.queue.forEach(q => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${q.sym}</b> <span class="badge m">⚡</span></td>
      <td style="text-align:right;"><span class="badge q">QUEUED ${q.side}</span></td>
      <td>—</td><td>—</td>
      <td>$${fmtN(q.notional)}</td>
      <td style="color:var(--muted)">waiting price…</td>
      <td>—</td><td></td>`;
    tb.appendChild(tr);
  });

  /* Pending */
  const openSyms = new Set(s.positions.map(p => normSym(p.sym)));
  const queueSyms = new Set(s.queue.map(q => normSym(q.sym)));
  const pending = s.settings.checked.filter(sym => !openSyms.has(normSym(sym)) && !queueSyms.has(normSym(sym)));

  const plans = pending.map(sym => {
    const S = normSym(sym);
    const sp = s.prices.spot[S], fu = s.prices.fut[S];
    if (sp == null || fu == null) return { sym, state: "NO PX" };
    const gap = (fu - sp) / sp;
    const side = gap > 0 ? "SHORT" : "LONG";
    const tick = s.prices.tickSizes[S] || 0.01;
    const tks = (fu - sp) / tick;
    const longGap = s.tradeSetup.longGap, shortGap = s.tradeSetup.shortGap;
    const gapOk = !s.tradeSetup.gapFilter || (side === "SHORT" ? tks >= longGap : tks <= -shortGap);
    let st;
    if (!s.tradeSetup.gapFilter) st = "READY";
    else if (gapOk) st = "READY";
    else if (Math.abs(tks) < (side === "SHORT" ? longGap : shortGap)) st = "WAITING";
    else st = "GAP_BLOCK";
    return { sym, side, gap, tks, spot: sp, fut: fu, gapOk, state: st };
  });

  const rank = { READY: 0, GAP_BLOCK: 1, WAITING: 2, "NO PX": 3 };
  plans.sort((a, b) => {
    const r = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
    if (r !== 0) return r;
    return Math.abs(b.gap || 0) - Math.abs(a.gap || 0);
  });

  if (plans.length) {
    const sec = document.createElement("tr");
    sec.className = "sec";
    const gapNote = s.tradeSetup.gapFilter ? ` · gap ↑${s.tradeSetup.longGap}t/↓${s.tradeSetup.shortGap}t` : "";
    sec.innerHTML = `<td colspan="8">Pending — sorted by distance from index price (${plans.length})${gapNote}</td>`;
    tb.appendChild(sec);

    plans.forEach(pl => {
      let sideHtml = `<span style="color:var(--muted)">—</span>`;
      if (pl.side) sideHtml = `<span class="badge ${pl.side === "LONG" ? "pl-l" : "pl-s"}">${pl.side}</span>`;
      let badge = "";
      if (pl.state === "READY") badge = `<span class="badge rdy">READY</span>`;
      else if (pl.state === "GAP_BLOCK") badge = `<span class="badge gap-blk">⛔ GAP BLOCK</span>`;
      else if (pl.state === "WAITING") badge = `<span class="badge wai">WAITING</span>`;
      else badge = `<span class="badge wai">NO PX</span>`;

      const entryCell = (pl.spot != null && pl.fut != null)
        ? `${fmtP(pl.fut)}<span class="sub">idx ${fmtP(pl.spot)}</span>`
        : `<span style="color:var(--muted)">—</span>`;

      let gapCell = `<span style="color:var(--muted)">—</span>`;
      if (pl.tks != null && pl.gap != null) {
        const cls = pl.tks >= 0 ? "neg" : "pos";
        gapCell = `<span class="${cls}" style="font-weight:bold;">${pl.tks >= 0 ? "+" : ""}${pl.tks.toFixed(1)}t</span>` +
                  `<span class="sub">${pl.gap >= 0 ? "+" : ""}${(pl.gap * 100).toFixed(3)}%</span>`;
      }

      const tr = document.createElement("tr");
      tr.className = "pend";
      tr.innerHTML = `
        <td><b>${pl.sym}</b> <span class="badge plan">PLANNED</span></td>
        <td style="text-align:right;">${sideHtml}</td>
        <td>${entryCell}</td>
        <td>—</td><td>—</td><td>—</td>
        <td>${gapCell}<span class="sub">${badge}</span></td>
        <td></td>`;
      tb.appendChild(tr);
    });
  }

  if (!s.positions.length && !s.queue.length && !plans.length) {
    tb.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:18px;">No active positions — turn on Autopilot</td></tr>`;
  }
}

function renderApBar(s) {
  const on = s.tradeSetup.autopilotOn;
  $("apPill").textContent = on ? "RUNNING" : "OFF";
  $("apPill").className = "pill " + (on ? "on" : "off");

  const gapOn = s.tradeSetup.gapFilter;
  $("gapPill").textContent = gapOn ? `GAP ON · ↑${s.tradeSetup.longGap}t / ↓${s.tradeSetup.shortGap}t` : "GAP OFF";
  $("gapPill").className = "pill " + (gapOn ? "gap-on" : "off");

  const maxOpen = s.tradeSetup.maxOpen;
  $("apActive").textContent = `${s.positions.length} / ${maxOpen}`;

  const openSyms = new Set(s.positions.map(p => normSym(p.sym)));
  const waiting = s.settings.checked.filter(sym => !openSyms.has(normSym(sym)));
  $("apWaiting").textContent = waiting.length;

  let ready = 0, blocked = 0;
  waiting.forEach(sym => {
    const S = normSym(sym);
    const sp = s.prices.spot[S], fu = s.prices.fut[S];
    if (sp == null || fu == null) return;
    const gap = (fu - sp) / sp;
    const side = gap > 0 ? "SHORT" : "LONG";
    const tick = s.prices.tickSizes[S] || 0.01;
    const tks = (fu - sp) / tick;
    const gapOk = !gapOn || (side === "SHORT" ? tks >= s.tradeSetup.longGap : tks <= -s.tradeSetup.shortGap);
    gapOk ? ready++ : blocked++;
  });
  $("apReady").textContent = ready;
  $("apGapBlocked").textContent = blocked;

  const nt = s.positions.reduce((sum, p) => {
    const cur = s.prices.fut[normSym(p.sym)];
    if (cur == null) return sum;
    const g = p.side === "LONG" ? (cur - p.entry) * p.amt : (p.entry - cur) * p.amt;
    return sum + g - p.fees;
  }, 0);
  const ntEl = $("apNet");
  ntEl.textContent = fmtSigned(nt);
  ntEl.className = nt >= 0 ? "pos" : "neg";

  let note = "—";
  if (on) {
    if (s.positions.length >= maxOpen) note = `Max open reached (${maxOpen})`;
    else if (ready > 0) note = `${ready} ready — entering`;
    else if (blocked > 0) note = `${blocked} gap-blocked`;
    else note = "Scanning…";
  } else note = `gap${gapOn ? "" : " off"} · 1 leg/tick`;
  $("apNote").textContent = note;
}

function renderLogs(s) {
  const top = s.logs.length ? s.logs[0] : '';
  if (top === lastLogTop) return;
  lastLogTop = top;
  $("log").innerHTML = s.logs.map(l => `<div>${l}</div>`).join("");
}

/* ---------- Events ---------- */
$("autopilot").addEventListener("change", e => sendAction("toggleAutopilot", e.target.checked));
$("gapFilter").addEventListener("change", e => sendAction("updateTradeSetup", { gapFilter: e.target.checked }));
$("longGap").addEventListener("change", e => sendAction("updateTradeSetup", { longGap: e.target.value }));
$("shortGap").addEventListener("change", e => sendAction("updateTradeSetup", { shortGap: e.target.value }));
$("maxOpen").addEventListener("change", e => sendAction("updateTradeSetup", { maxOpen: e.target.value }));
$("sl").addEventListener("change", e => sendAction("updateTradeSetup", { sl: e.target.value }));
$("amt").addEventListener("change", e => sendAction("updateTradeSetup", { amt: e.target.value }));
$("fee").addEventListener("change", e => sendAction("updateTradeSetup", { fee: e.target.value }));
$("btnFetch").addEventListener("click", () => sendAction("fetchPrices"));
$("btnExit").addEventListener("click", () => {
  if (confirm("Exit all positions and stop autopilot?")) sendAction("exitAll");
});
$("btnReset").addEventListener("click", () => {
  if (confirm("Reset session stats? Open positions stay open.")) sendAction("resetSession");
});
$("addSym").addEventListener("click", () => {
  const v = $("newSym").value.trim().toUpperCase();
  if (v) { sendAction("addSymbol", { symbol: v }); $("newSym").value = ""; }
});
$("newSym").addEventListener("keydown", e => { if (e.key === "Enter") $("addSym").click(); });

/* ---------- Poll ---------- */
fetchState();
setInterval(fetchState, 1000);
