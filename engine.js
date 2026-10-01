// engine.js — runs 24/7 on the server
const WebSocket = require('ws');

const state = {
  symbols: ["AVAX","SUI","DOT","ATOM","ICP","NEAR","APT","INJ"],
  spot: {}, fut: {},
  positions: [],
  realizedPnl: 0, realizedFees: 0,
  tradeCount: 0, wins: 0, losses: 0,
  sessionStart: Date.now(),
  autopilot: true,
  apTarget: 0.05,
  maxOpen: 5,
  amt: 10,
  feePct: 0.001,
  longGap: 10,
  shortGap: 10,
  normEnabled: true,
  normLoss: 0.01,
  normProfit: 0.10,
  tickSizes: {},
  lastTickAt: {}
};

// --- WebSocket: spot + futures ---
function startFeeds() {
  const streams = state.symbols.map(s => s.toLowerCase() + "usdt@miniTicker").join("/");
  const spot = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams);
  const fut  = new WebSocket("wss://fstream.binance.com/stream?streams=" + streams);

  spot.on("message", raw => {
    const m = JSON.parse(raw); const d = m.data; if (!d) return;
    const sym = d.s.replace("USDT","");
    state.spot[sym] = parseFloat(d.c);
    state.lastTickAt[sym] = Date.now();
  });
  fut.on("message", raw => {
    const m = JSON.parse(raw); const d = m.data; if (!d) return;
    const sym = d.s.replace("USDT","");
    state.fut[sym] = parseFloat(d.c);
    state.lastTickAt[sym] = Date.now();
  });

  // Auto-reconnect
  spot.on("close", () => setTimeout(startFeeds, 5000));
  fut.on("close",  () => setTimeout(startFeeds, 5000));
}

// --- Tick sizes from REST once at startup ---
async function loadTickSizes() {
  try {
    const r = await fetch("https://api.binance.com/api/v3/exchangeInfo");
    const j = await r.json();
    for (const s of j.symbols) {
      if (!s.symbol.endsWith("USDT")) continue;
      const f = s.filters.find(x => x.filterType === "PRICE_FILTER");
      if (f) state.tickSizes[s.symbol.slice(0,-4)] = parseFloat(f.tickSize);
    }
  } catch(e) { console.error("tickSizes:", e.message); }
}

// --- Core calculations (ported from your browser code) ---
function gapTicks(sym) {
  const sp = state.spot[sym], fu = state.fut[sym];
  if (!sp || !fu) return null;
  const tick = state.tickSizes[sym] || 0.0001;
  return (fu - sp) / tick;
}

function netAt(pos, cur) {
  const gross = pos.side === "LONG"
    ? (cur - pos.entry) * pos.amt
    : (pos.entry - cur) * pos.amt;
  return gross - pos.fees;
}

// --- Autopilot loop: runs every second forever ---
function autopilotTick() {
  if (!state.autopilot) return;
  const now = Date.now();

  // 1. Exit each leg at +target
  for (let i = state.positions.length - 1; i >= 0; i--) {
    const p = state.positions[i];
    const cur = state.fut[p.sym];
    if (!cur) continue;
    const net = netAt(p, cur);
    if (net >= state.apTarget) {
      state.realizedPnl += net;
      state.realizedFees += p.fees;
      state.tradeCount++;
      if (net >= 0) state.wins++; else state.losses++;
      state.positions.splice(i, 1);
      console.log(`[EXIT] ${p.side} ${p.sym} net ${net.toFixed(4)}`);
    }
  }

  // 2. Norm profit close-all
  if (state.normEnabled && state.positions.length) {
    const total = state.positions.reduce((s,p) =>
      s + netAt(p, state.fut[p.sym] || p.entry), 0);
    if (total >= state.normProfit) {
      // close all
      for (const p of state.positions) {
        const cur = state.fut[p.sym] || p.entry;
        const net = netAt(p, cur);
        state.realizedPnl += net;
        state.tradeCount++;
        if (net >= 0) state.wins++; else state.losses++;
      }
      state.positions = [];
      console.log(`[NORM PROFIT] closed all at +${total.toFixed(4)}`);
      return;
    }
  }

  // 3. Max open reached?
  if (state.positions.length >= state.maxOpen) return;

  // 4. Norm loss gate
  if (state.normEnabled && state.positions.length) {
    const total = state.positions.reduce((s,p) =>
      s + netAt(p, state.fut[p.sym] || p.entry), 0);
    if (total > -state.normLoss) return;
  }

  // 5. Find best candidate (farthest from index price, gap confirmed)
  const openSyms = new Set(state.positions.map(p => p.sym));
  let best = null;
  for (const sym of state.symbols) {
    if (openSyms.has(sym)) continue;
    const sp = state.spot[sym], fu = state.fut[sym];
    if (!sp || !fu) continue;
    const gap = (fu - sp) / sp;
    const side = gap > 0 ? "SHORT" : "LONG";
    const tks = gapTicks(sym);
    if (tks == null) continue;
    const ok = side === "SHORT" ? tks >= state.longGap : tks <= -state.shortGap;
    if (!ok) continue;
    if (!best || Math.abs(gap) > Math.abs(best.gap)) best = { sym, side, gap, price: fu, spot: sp };
  }
  if (!best) return;

  // 6. Open the leg
  const qty = state.amt / best.price;
  const fee = qty * best.price * state.feePct;
  state.positions.push({
    id: Date.now(),
    sym: best.sym, side: best.side,
    entry: best.price, amt: qty,
    fees: fee, spot: best.spot,
    openedAt: now
  });
  console.log(`[OPEN] ${best.side} ${best.sym} @ ${best.price} qty ${qty}`);
}

// --- Snapshot for the frontend ---
function snapshot() {
  return {
    spot: state.spot,
    fut: state.fut,
    positions: state.positions,
    realizedPnl: state.realizedPnl,
    realizedFees: state.realizedFees,
    tradeCount: state.tradeCount,
    wins: state.wins, losses: state.losses,
    sessionStart: state.sessionStart,
    autopilot: state.autopilot,
    lastTickAt: state.lastTickAt
  };
}

module.exports = { state, startFeeds, loadTickSizes, autopilotTick, snapshot };
