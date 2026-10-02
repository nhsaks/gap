const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const STATE_FILE = path.join(__dirname, 'state.json');

/* ---------- Constants ---------- */
const FRESH_MS = 15000;
const QUEUE_TTL = 180000;
const WS_SILENT = 25000;
const MAX_MULT = 10;
const STRENGTH_REF = 0.005;
const RECOVER_MULT = 0.5;
const ENTRY_COOLDOWN = 900;
const EXIT_TARGET = 0.05;      // hardcoded per-leg TP (since Exit $ input removed)
const CONN_DEBOUNCE = 2500;

const DEFAULT_SYMBOLS = ["AVAX","SUI","DOT","ATOM","ICP","NEAR","APT","ARB","OP","INJ","TIA","SEI","FIL","LTC","LINK"];
const DEFAULT_CHECKED = ["AVAX","SUI","DOT","ATOM","ICP","NEAR","APT","INJ"];

/* ---------- State ---------- */
const state = {
  symbols: [...DEFAULT_SYMBOLS],
  checked: [...DEFAULT_CHECKED],
  spot: {}, spotPrev: {}, spotAt: {},
  fut: {}, futPrev: {}, futAt: {},
  tickSizes: {}, tickAt: {},
  positions: [], queue: [],
  sessionStart: Date.now(),
  realizedPnl: 0, realizedFees: 0,
  tradeCount: 0, wins: 0, losses: 0,
  logs: [],
  tradeSetup: {
    autopilotOn: false,
    gapFilter: true,
    longGap: 10,
    shortGap: 10,
    maxOpen: 5,
    sl: 0.15,
    amt: 10,
    fee: 0,
  },
  lastEntryAt: 0,
  posSeq: 1,
  connStatus: { spot: false, fut: false, lastMsg: 0 },
  lastRest: {},
  tradeEnabled: false,
  lastConnectAt: 0,
  retry: 0,
  spotWs: null,
  futWs: null,
};

/* ---------- Helpers ---------- */
const normSym = s => String(s || "").toUpperCase().trim();
const fmtN = n => {
  if (n == null || !isFinite(n)) return "—";
  if (Math.abs(n) < 1e-9) return "0";
  return n.toFixed(4).replace(/\.?0+$/, '');
};
function log(msg) {
  const time = new Date().toLocaleTimeString();
  const clean = String(msg).replace(/<[^>]*>/g, '');
  state.logs.unshift(`[${time}] ${clean}`);
  if (state.logs.length > 100) state.logs.pop();
}

/* ---------- Price Store ---------- */
function setSpot(sym, p) {
  const S = normSym(sym), v = parseFloat(p);
  if (!isFinite(v) || v <= 0) return false;
  const old = state.spot[S];
  if (old !== v) state.spotPrev[S] = old;
  state.spot[S] = v;
  const now = Date.now();
  state.spotAt[S] = now; state.tickAt[S] = now;
  return true;
}
function setFut(sym, p) {
  const S = normSym(sym), v = parseFloat(p);
  if (!isFinite(v) || v <= 0) return false;
  const old = state.fut[S];
  if (old !== v) state.futPrev[S] = old;
  state.fut[S] = v;
  const now = Date.now();
  state.futAt[S] = now; state.tickAt[S] = now;
  return true;
}
const spotPx = sym => { const v = state.spot[normSym(sym)]; return (v == null || !isFinite(v)) ? null : v; };
const futPx  = sym => { const v = state.fut[normSym(sym)];  return (v == null || !isFinite(v)) ? null : v; };
const isFresh = (sym, ms = FRESH_MS) => {
  const t = state.tickAt[normSym(sym)];
  return t != null && (Date.now() - t) <= ms;
};
const freshSpot = sym => isFresh(sym) ? spotPx(sym) : null;
const freshFut  = sym => isFresh(sym) ? futPx(sym)  : null;

/* ---------- Tick size / gap ---------- */
function defaultTickSize(price) {
  if (price == null || !isFinite(price) || price <= 0) return 0.01;
  if (price >= 10000) return 0.10;
  if (price >= 100) return 0.01;
  if (price >= 1) return 0.001;
  if (price >= 0.1) return 0.0001;
  if (price >= 0.01) return 0.00001;
  return 0.000001;
}
function tickSizeFor(sym) {
  const S = normSym(sym);
  if (state.tickSizes[S] > 0) return state.tickSizes[S];
  return defaultTickSize(spotPx(S) ?? futPx(S));
}
function gapTicks(sym) {
  const S = normSym(sym);
  const sp = spotPx(S), fu = futPx(S);
  if (sp == null || fu == null || sp <= 0) return null;
  const tick = tickSizeFor(S);
  if (!tick || tick <= 0) return null;
  return (fu - sp) / tick;
}

/* ---------- Gap filter ---------- */
function gapConfirms(sym, side) {
  if (!state.tradeSetup.gapFilter) return { ok: true, ticks: null, reason: "off" };
  const ticks = gapTicks(sym);
  if (ticks == null) return { ok: false, ticks: null, reason: "missing" };
  if (side === "SHORT") {
    const ok = ticks >= state.tradeSetup.longGap;
    return { ok, ticks, reason: ok ? "ok" : "small" };
  }
  const ok = ticks <= -state.tradeSetup.shortGap;
  return { ok, ticks, reason: ok ? "ok" : "small" };
}

/* ---------- Signal ---------- */
function signalFor(sym) {
  const S = normSym(sym);
  const sp = freshSpot(S), fu = freshFut(S);
  if (sp == null || fu == null || sp <= 0) return null;
  const gap = (fu - sp) / sp;
  if (Math.abs(gap) < 1e-12) return null;
  return { spot: sp, fut: fu, gap, side: gap > 0 ? "SHORT" : "LONG" };
}

function planEntry(sym, openNet) {
  const sig = signalFor(sym);
  if (!sig) return null;
  const base = state.tradeSetup.amt;
  if (!isFinite(base) || base <= 0) return null;
  const agap = Math.abs(sig.gap);
  const strength = Math.min(3, Math.max(0.5, agap / STRENGTH_REF));
  let notional = base * strength;
  const recover = Math.max(0, -(openNet || 0));
  if (recover > 0) notional += recover * RECOVER_MULT * strength;
  notional = Math.min(notional, base * MAX_MULT);
  notional = Math.max(notional, base * 0.25);
  return { side: sig.side, notional, spot: sig.spot, fut: sig.fut, gap: sig.gap, strength };
}

/* ---------- Positions ---------- */
function grossAt(pos, cur) {
  if (cur == null || !isFinite(cur)) return 0;
  return pos.side === "LONG" ? (cur - pos.entry) * pos.amt : (pos.entry - cur) * pos.amt;
}
const netAt = (pos, cur) => grossAt(pos, cur) - pos.fees;
const totalFees = () => state.positions.reduce((s, p) => s + p.fees, 0);

function totalNet(freshOnly) {
  let sum = 0;
  for (const p of state.positions) {
    const c = freshOnly ? freshFut(p.sym) : futPx(p.sym);
    if (c == null) { if (freshOnly) return null; continue; }
    sum += netAt(p, c);
  }
  return sum;
}

function findPosIndex(sym, side) {
  const S = normSym(sym);
  for (let i = 0; i < state.positions.length; i++) {
    const p = state.positions[i];
    if (normSym(p.sym) === S && p.side === side) return i;
  }
  return -1;
}

function executeOpen(sym, side, amt, source, notional, forcedPx, spotRef) {
  const S = normSym(sym);
  const price = (forcedPx != null && isFinite(forcedPx)) ? forcedPx : freshFut(S);
  if (price == null) return false;
  if (!isFinite(amt) || amt <= 0) return false;
  if (!notional) notional = amt * price;

  const f = (state.tradeSetup.fee || 0) / 100;
  const addFee = amt * price * f;
  const idx = findPosIndex(S, side);

  if (idx !== -1) {
    const p = state.positions[idx];
    const oldAmt = p.amt, oldEntry = p.entry;
    const newAmt = oldAmt + amt;
    const newEntry = (oldEntry * oldAmt + price * amt) / newAmt;
    p.entry = newEntry; p.amt = newAmt; p.fees += addFee;
    p.adds = (p.adds || 1) + 1;
    p.notional = (p.notional || (oldAmt * oldEntry)) + notional;
    if (spotRef != null) p.spot = spotRef;
    log(`AVERAGE ${side} ${S}: ${fmtN(oldAmt)} @ ${price.toFixed(6)} + ${fmtN(amt)} @ ${price.toFixed(6)} -> ${fmtN(newAmt)} @ ${newEntry.toFixed(6)} (x${p.adds})`);
  } else {
    state.positions.push({
      id: state.posSeq++,
      sym: S, side,
      entry: price, amt,
      fees: addFee, adds: 1,
      notional,
      openedAt: Date.now(),
      spot: spotRef ?? spotPx(S) ?? null,
    });
    const tag = source === "auto" ? " [gap]" : source === "queue" ? " [queued]" : "";
    log(`OPEN ${side} ${S}: ${fmtN(amt)} @ ${price.toFixed(6)} ($${fmtN(notional)} USDT)${f ? ` (fee ${fmtN(addFee)})` : ""}${tag}`);
  }
  return true;
}

function closePos(id, reason, usePx) {
  const idx = state.positions.findIndex(p => p.id === id);
  if (idx < 0) return;
  const p = state.positions[idx];
  let cur = (usePx != null && isFinite(usePx)) ? usePx : freshFut(p.sym);
  if (cur == null) cur = futPx(p.sym) ?? p.entry;

  const f = (state.tradeSetup.fee || 0) / 100;
  p.fees += p.amt * cur * f;
  const net = grossAt(p, cur) - p.fees;

  state.realizedPnl += net;
  state.realizedFees += p.fees;
  state.tradeCount++;
  net >= 0 ? state.wins++ : state.losses++;

  log(`${reason || "CLOSE"} ${p.side} ${p.sym} qty ${fmtN(p.amt)} @ ${cur.toFixed(6)} -> PnL ${net >= 0 ? "+" : ""}${fmtN(net)}`);
  state.positions.splice(idx, 1);
}

function closeAll(reason) {
  if (!state.positions.length) return false;
  [...state.positions].forEach(p => closePos(p.id, reason));
  return true;
}

/* ---------- Queue ---------- */
function flushQueue() {
  if (!state.queue.length) return;
  const now = Date.now();
  for (let i = state.queue.length - 1; i >= 0; i--) {
    const q = state.queue[i];
    if (now - (q.at || 0) > QUEUE_TTL) {
      state.queue.splice(i, 1);
      log(`Queued ${q.side} ${q.sym} expired`);
      continue;
    }
    const price = freshFut(q.sym);
    if (price != null) {
      if (state.tradeSetup.gapFilter && !gapConfirms(q.sym, q.side).ok) {
        state.queue.splice(i, 1);
        log(`Queued ${q.side} ${q.sym} cancelled - gap filter fail`);
        continue;
      }
      if (executeOpen(q.sym, q.side, q.notional / price, "queue", q.notional, price, spotPx(q.sym))) {
        state.queue.splice(i, 1);
      }
    }
  }
}

/* ---------- Autopilot ---------- */
function autopilotTick() {
  if (!state.tradeSetup.autopilotOn) return;

  const syms = [...state.checked];
  if (!syms.length) return;

  const maxOpen = Math.max(1, state.tradeSetup.maxOpen || 5);
  const sl = state.tradeSetup.sl;

  // Per-leg TP
  [...state.positions].forEach(p => {
    const cur = freshFut(p.sym);
    if (cur == null) return;
    if (netAt(p, cur) >= EXIT_TARGET) closePos(p.id, `EXIT +${fmtN(EXIT_TARGET)}`, cur);
  });

  // Basket SL
  const nt = totalNet(true);
  if (nt != null && isFinite(sl) && sl > 0 && nt <= -sl) {
    log(`BASKET SL - net ${nt.toFixed(4)} <= -${fmtN(sl)} - closing all`);
    closeAll(`SL ${nt.toFixed(4)}`);
    return;
  }

  // Refill
  if (state.positions.length >= maxOpen) return;
  if (Date.now() - state.lastEntryAt < ENTRY_COOLDOWN) return;

  const openNet = totalNet(true) ?? 0;
  const openSyms = new Set(state.positions.map(p => normSym(p.sym)));
  const pool = syms.filter(s => !openSyms.has(normSym(s)));
  if (!pool.length) return;

  const candidates = [];
  for (const s of pool) {
    if (!isFresh(s)) continue;
    const sig = signalFor(s);
    if (!sig) continue;
    const price = freshFut(s);
    if (price == null) continue;
    const g = gapConfirms(s, sig.side);
    if (state.tradeSetup.gapFilter && !g.ok) continue;
    candidates.push({ sym: s, price, absGap: Math.abs(sig.gap), side: sig.side, gapTicks: g.ticks });
  }
  if (!candidates.length) return;

  candidates.sort((a, b) => b.absGap - a.absGap);
  const pick = candidates[0];
  const plan = planEntry(pick.sym, openNet);
  if (!plan) return;

  if (executeOpen(pick.sym, plan.side, plan.notional / pick.price, "auto", plan.notional, pick.price, plan.spot)) {
    state.lastEntryAt = Date.now();
    const gTag = (state.tradeSetup.gapFilter && pick.gapTicks != null)
      ? ` · gap ${pick.gapTicks >= 0 ? "+" : ""}${pick.gapTicks.toFixed(1)} ticks` : "";
    log(`GAP ${pick.sym}: fut ${pick.price.toFixed(6)} vs spot ${plan.spot.toFixed(6)} (${(plan.gap*100).toFixed(4)}%) -> ${plan.side} $${fmtN(plan.notional)} (x${plan.strength.toFixed(2)})${gTag}`);
  }
}

/* ---------- WebSockets ---------- */
const SPOT_WS = [
  s => "wss://stream.binance.com:9443/stream?streams=" + s,
  s => "wss://stream.binance.com:443/stream?streams=" + s
];
const FUT_WS = [
  s => "wss://fstream.binance.com/stream?streams=" + s,
  s => "wss://fstream.binance.com/market/stream?streams=" + s
];

function connect() {
  const now = Date.now();
  if (now - state.lastConnectAt < CONN_DEBOUNCE) return;
  state.lastConnectAt = now;

  if (state.spotWs) { try { state.spotWs.terminate(); } catch(e){} state.spotWs = null; }
  if (state.futWs)  { try { state.futWs.terminate(); }  catch(e){} state.futWs = null; }
  state.connStatus.spot = false; state.connStatus.fut = false;

  const syms = [...state.symbols];
  if (!syms.length) return;
  const streams = syms.map(s => s.toLowerCase() + "usdt@miniTicker").join("/");

  const trySpot = (ui) => {
    let ws;
    try { ws = new WebSocket(SPOT_WS[ui % SPOT_WS.length](streams)); }
    catch(e) { setTimeout(() => trySpot(ui + 1), 2000); return; }
    state.spotWs = ws;
    ws.on('open', () => { state.connStatus.spot = true; state.connStatus.lastMsg = Date.now(); log("Spot WS connected"); });
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString());
        const d = m.data; if (!d || !d.s) return;
        const sym = normSym(d.s.endsWith("USDT") ? d.s.slice(0, -4) : d.s);
        const p = parseFloat(d.c);
        if (!isFinite(p) || p <= 0) return;
        state.connStatus.lastMsg = Date.now();
        setSpot(sym, p);
      } catch(e){}
    });
    ws.on('close', () => { state.connStatus.spot = false; setTimeout(() => trySpot(ui + 1), Math.min(15000, 1000 * (state.retry++ + 1))); });
    ws.on('error', () => { try { ws.terminate(); } catch(e){} });
  };

  const tryFut = (ui) => {
    let ws;
    try { ws = new WebSocket(FUT_WS[ui % FUT_WS.length](streams)); }
    catch(e) { setTimeout(() => tryFut(ui + 1), 2000); return; }
    state.futWs = ws;
    ws.on('open', () => { state.connStatus.fut = true; state.connStatus.lastMsg = Date.now(); log("Futures WS connected"); });
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(data.toString());
        const d = m.data; if (!d || !d.s) return;
        const sym = normSym(d.s.endsWith("USDT") ? d.s.slice(0, -4) : d.s);
        const p = parseFloat(d.c);
        if (!isFinite(p) || p <= 0) return;
        state.connStatus.lastMsg = Date.now();
        setFut(sym, p);
      } catch(e){}
    });
    ws.on('close', () => { state.connStatus.fut = false; setTimeout(() => tryFut(ui + 1), Math.min(15000, 1000 * (state.retry++ + 1))); });
    ws.on('error', () => { try { ws.terminate(); } catch(e){} });
  };

  trySpot(0); tryFut(0);
}

/* ---------- REST fallback ---------- */
async function restSpotAll() {
  const wanted = new Set(state.symbols.map(normSym));
  for (const u of ["https://api.binance.com/api/v3/ticker/24hr","https://api.binance.us/api/v3/ticker/24hr"]) {
    try {
      const r = await fetch(u, { cache: "no-store" });
      if (!r.ok) continue;
      const j = await r.json();
      if (!Array.isArray(j)) continue;
      let n = 0;
      for (const t of j) {
        if (!t?.symbol?.endsWith("USDT")) continue;
        const sym = t.symbol.slice(0, -4);
        if (!wanted.has(sym)) continue;
        if (setSpot(sym, parseFloat(t.lastPrice))) n++;
      }
      return n;
    } catch(e){}
  }
  return 0;
}
async function restFutAll() {
  const wanted = new Set(state.symbols.map(normSym));
  try {
    const r = await fetch("https://fapi.binance.com/fapi/v1/ticker/24hr", { cache: "no-store" });
    if (!r.ok) return 0;
    const j = await r.json();
    if (!Array.isArray(j)) return 0;
    let n = 0;
    for (const t of j) {
      if (!t?.symbol?.endsWith("USDT")) continue;
      const sym = t.symbol.slice(0, -4);
      if (!wanted.has(sym)) continue;
      if (setFut(sym, parseFloat(t.lastPrice))) n++;
    }
    return n;
  } catch(e){}
  return 0;
}
async function fetchTickSizes() {
  try {
    const r = await fetch("https://api.binance.com/api/v3/exchangeInfo", { cache: "no-store" });
    if (!r.ok) throw new Error("fail");
    const j = await r.json();
    if (!Array.isArray(j?.symbols)) return;
    let n = 0;
    for (const s of j.symbols) {
      if (!s?.symbol?.endsWith("USDT")) continue;
      if (s.status && s.status !== "TRADING") continue;
      const sym = s.symbol.slice(0, -4);
      const f = (s.filters || []).find(x => x.filterType === "PRICE_FILTER");
      if (f?.tickSize) {
        const t = parseFloat(f.tickSize);
        if (isFinite(t) && t > 0) { state.tickSizes[sym] = t; n++; }
      }
    }
    log(`Loaded ${n} tick sizes from Binance`);
  } catch(e) { log("Tick sizes: fallback heuristic"); }
}

/* ---------- Persistence ---------- */
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      symbols: state.symbols,
      checked: state.checked,
      positions: state.positions,
      sessionStart: state.sessionStart,
      realizedPnl: state.realizedPnl,
      realizedFees: state.realizedFees,
      tradeCount: state.tradeCount,
      wins: state.wins,
      losses: state.losses,
      posSeq: state.posSeq,
      tradeSetup: state.tradeSetup,
      logs: state.logs.slice(0, 50),
    }, null, 2));
  } catch(e) { console.error("saveState:", e); }
}
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(s.symbols)) state.symbols = s.symbols;
    if (Array.isArray(s.checked)) state.checked = s.checked;
    if (Array.isArray(s.positions)) state.positions = s.positions;
    if (s.sessionStart != null) state.sessionStart = s.sessionStart;
    if (s.realizedPnl != null) state.realizedPnl = s.realizedPnl;
    if (s.realizedFees != null) state.realizedFees = s.realizedFees;
    if (s.tradeCount != null) state.tradeCount = s.tradeCount;
    if (s.wins != null) state.wins = s.wins;
    if (s.losses != null) state.losses = s.losses;
    if (s.posSeq != null) state.posSeq = s.posSeq;
    if (s.tradeSetup) Object.assign(state.tradeSetup, s.tradeSetup);
    if (Array.isArray(s.logs)) state.logs = s.logs;
  } catch(e) { console.error("loadState:", e); }
}

/* ---------- Public API ---------- */
function getState() {
  return {
    session: {
      startTime: state.sessionStart,
      duration: Date.now() - state.sessionStart,
      trades: state.tradeCount,
      wins: state.wins,
      losses: state.losses,
      feesPaid: state.realizedFees,
      realizedPnl: state.realizedPnl,
    },
    settings: { symbols: state.symbols, checked: state.checked },
    tradeSetup: { ...state.tradeSetup },
    prices: { spot: state.spot, fut: state.fut, tickSizes: state.tickSizes, tickAt: state.tickAt },
    positions: state.positions,
    queue: state.queue,
    logs: state.logs,
    connStatus: state.connStatus,
    nPos: state.positions.length,
    nQueue: state.queue.length,
  };
}
function toggleAutopilot(val) {
  state.tradeSetup.autopilotOn = !!val;
  if (val) { state.sessionStart = Date.now(); log("Autopilot STARTED"); }
  else log("Autopilot STOPPED");
  saveState();
}
function updateTradeSetup(p) {
  const t = state.tradeSetup;
  if (p.gapFilter !== undefined) t.gapFilter = !!p.gapFilter;
  if (p.longGap   !== undefined) t.longGap = parseFloat(p.longGap) || 10;
  if (p.shortGap  !== undefined) t.shortGap = parseFloat(p.shortGap) || 10;
  if (p.maxOpen   !== undefined) t.maxOpen = parseInt(p.maxOpen) || 5;
  if (p.sl        !== undefined) t.sl = parseFloat(p.sl) || 0;
  if (p.amt       !== undefined) t.amt = parseFloat(p.amt) || 0;
  if (p.fee       !== undefined) t.fee = parseFloat(p.fee) || 0;
  saveState();
}
function toggleSymbol(sym, on) {
  const S = normSym(sym);
  if (on) { if (!state.checked.includes(S)) state.checked.push(S); }
  else state.checked = state.checked.filter(x => x !== S);
  saveState();
}
function addSymbol(sym) {
  const S = normSym(sym);
  if (!S) return;
  if (!state.symbols.includes(S)) {
    state.symbols.push(S);
    log(`Added symbol ${S}`);
    state.lastConnectAt = 0; connect();
  }
  if (!state.checked.includes(S)) state.checked.push(S);
  saveState();
}
function removeSymbol(sym) {
  const S = normSym(sym);
  if (state.positions.some(p => normSym(p.sym) === S)) {
    log(`Cannot remove ${S} - close positions first`); return;
  }
  state.symbols = state.symbols.filter(x => x !== S);
  state.checked = state.checked.filter(x => x !== S);
  state.queue   = state.queue.filter(q => normSym(q.sym) !== S);
  delete state.spot[S]; delete state.fut[S]; delete state.tickAt[S]; delete state.tickSizes[S];
  log(`Removed symbol ${S}`);
  state.lastConnectAt = 0; connect();
  saveState();
}
function resetSession() {
  state.sessionStart = Date.now();
  state.realizedPnl = 0; state.realizedFees = 0;
  state.tradeCount = 0; state.wins = 0; state.losses = 0;
  log("Session reset");
  saveState();
}
function exitAll() {
  state.queue = [];
  state.tradeSetup.autopilotOn = false;
  closeAll("EXIT ALL");
  log("Autopilot stopped");
  saveState();
}
function closePosition(id) {
  closePos(parseInt(id), "MANUAL");
  saveState();
}
async function fetchPrices() {
  log(`FETCH -> spot + futures for ${state.symbols.length} symbols`);
  if (!state.connStatus.spot || !state.connStatus.fut) connect();
  if (!Object.keys(state.tickSizes).length) await fetchTickSizes();
  await Promise.all([restSpotAll(), restFutAll()]);
  const ok = state.symbols.filter(s => spotPx(s) != null && futPx(s) != null);
  state.tradeEnabled = ok.length > 0;
  log(`Fetched ${ok.length}/${state.symbols.length} prices`);
  return ok.length;
}

/* ---------- Boot ---------- */
function boot() {
  loadState();
  fetchTickSizes().then(() => {
    connect();
    restSpotAll(); restFutAll();
  });

  setInterval(autopilotTick, 1000);
  setInterval(flushQueue, 1000);
  setInterval(saveState, 3000);
  setInterval(() => Promise.all([restSpotAll(), restFutAll()]), 3000);

  setInterval(() => {
    if (Date.now() - state.connStatus.lastMsg > WS_SILENT) {
      log("WS silent - reconnecting");
      state.connStatus.lastMsg = Date.now();
      state.lastConnectAt = 0;
      connect();
    }
  }, 5000);

  // Keep-alive self-ping to prevent Render from sleeping
  setInterval(() => {
    const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
    fetch(`${url}/api/state`).then(() => console.log('Keep-alive OK')).catch(e => console.log('Ping fail:', e.message));
  }, 14 * 60 * 1000);
}

module.exports = {
  boot, getState, toggleAutopilot, updateTradeSetup, toggleSymbol,
  addSymbol, removeSymbol, resetSession, exitAll, closePosition, fetchPrices,
};
