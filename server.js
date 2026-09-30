'use strict';
const express = require('express');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const STATE_FILE = path.join(__dirname, 'state.json');

const FRESH_MS = 15000;
const QUEUE_TTL = 180000;
const WS_SILENT = 25000;
const MAX_MULT = 10;
const STRENGTH_REF = 0.005;
const RECOVER_MULT = 0.5;
const ENTRY_COOLDOWN = 900;

const DEFAULT_SYMBOLS = ["AVAX","SUI","DOT","ATOM","ICP","NEAR","APT","ARB","OP","INJ","TIA","SEI","FIL","LTC","LINK"];
const DEFAULT_CHECKED = ["AVAX","SUI","DOT","ATOM","ICP","NEAR","APT","INJ"];

const state = {
  symbols: [...DEFAULT_SYMBOLS],
  checked: [...DEFAULT_CHECKED],
  spot: {}, fut: {}, tickAt: {}, tickSizes: {}, lastRest: {},
  positions: [], queue: [],
  posSeq: 1,
  sessionStart: Date.now(),
  realizedPnl: 0, realizedFees: 0,
  tradeCount: 0, wins: 0, losses: 0,
  settings: {
    autopilot: false, gapFilter: true,
    longGap: 10, shortGap: 10,
    apTarget: 0.05, maxOpen: 5, sl: 0.15,
    amt: 10, fee: 0,
    normEnabled: true, normalizeLoss: 0.01, normalizeProfit: 0.10,
    tp: 0.05, driftUp: 0, driftDn: 0, refreshSec: 3,
    target: '*'
  },
  logs: [],
  lastTickAt: 0,
  lastEntryAt: 0,
  apCycles: 0,
  ws: { spotOpen: false, futOpen: false, lastMsg: 0 },
  restBusy: false
};

function log(msg, cls) {
  const t = new Date().toISOString().slice(11,19);
  state.logs.unshift({ t, msg, cls: cls || '' });
  if (state.logs.length > 200) state.logs.length = 200;
  console.log(`[${t}] ${String(msg).replace(/<[^>]+>/g,'')}`);
}

const normSym = s => String(s || '').toUpperCase().trim();
const spotPx = s => state.spot[normSym(s)] ?? null;
const futPx  = s => state.fut[normSym(s)] ?? null;
const isFresh = (s, ms = FRESH_MS) => {
  const t = state.tickAt[normSym(s)];
  return t != null && (Date.now() - t) <= ms;
};
const freshSpot = s => isFresh(s) ? spotPx(s) : null;
const freshFut  = s => isFresh(s) ? futPx(s) : null;

function setSpot(sym, p){ const S=normSym(sym); const v=parseFloat(p); if(!isFinite(v)||v<=0) return false; state.spot[S]=v; state.tickAt[S]=Date.now(); state.lastTickAt=Date.now(); return true; }
function setFut(sym, p){  const S=normSym(sym); const v=parseFloat(p); if(!isFinite(v)||v<=0) return false; state.fut[S]=v;  state.tickAt[S]=Date.now(); state.lastTickAt=Date.now(); return true; }

function defaultTickSize(price){
  if (price == null || !isFinite(price) || price <= 0) return 0.01;
  if (price >= 10000) return 0.10;
  if (price >= 100) return 0.01;
  if (price >= 1) return 0.001;
  if (price >= 0.1) return 0.0001;
  if (price >= 0.01) return 0.00001;
  return 0.000001;
}
function tickSizeFor(sym){
  const S = normSym(sym);
  if (state.tickSizes[S] > 0) return state.tickSizes[S];
  const p = spotPx(S) ?? futPx(S);
  return defaultTickSize(p);
}
function gapTicks(sym){
  const S=normSym(sym); const sp=spotPx(S), fu=futPx(S);
  if (sp==null||fu==null||sp<=0) return null;
  const tick = tickSizeFor(S); if (!tick) return null;
  return (fu - sp) / tick;
}
function gapPct(sym){
  const S=normSym(sym); const sp=spotPx(S), fu=futPx(S);
  if (sp==null||fu==null||sp<=0) return null;
  return ((fu - sp) / sp) * 100;
}

const feePct        = () => { const v=parseFloat(state.settings.fee); return (isFinite(v)&&v>0)? v/100 : 0; };
const normEnabled   = () => state.settings.normEnabled;
const gapEnabled    = () => state.settings.gapFilter;
const longGapTicks  = () => { const v=parseFloat(state.settings.longGap);  return (isFinite(v)&&v>=1)? v : 10; };
const shortGapTicks = () => { const v=parseFloat(state.settings.shortGap); return (isFinite(v)&&v>=1)? v : 10; };
const normalizeLoss   = () => { const v=parseFloat(state.settings.normalizeLoss);   return (isFinite(v)&&v>0)? v : 0.01; };
const normalizeProfit = () => { const v=parseFloat(state.settings.normalizeProfit); return (isFinite(v)&&v>0)? v : 0.10; };

function gapConfirms(sym, side){
  if (!gapEnabled()) return { ok: true, ticks: null };
  const ticks = gapTicks(sym);
  if (ticks == null) return { ok: false, ticks: null };
  if (side === 'SHORT') return { ok: ticks >=  longGapTicks(), ticks };
  return { ok: ticks <= -shortGapTicks(), ticks };
}

function signalFor(sym){
  const S = normSym(sym);
  const sp = freshSpot(S), fu = freshFut(S);
  if (sp == null || fu == null || sp <= 0) return null;
  const gap = (fu - sp) / sp;
  if (Math.abs(gap) < 1e-12) return null;
  return { spot: sp, fut: fu, gap, side: gap > 0 ? 'SHORT' : 'LONG' };
}

function grossAt(pos, cur){
  if (cur == null || !isFinite(cur)) return 0;
  return pos.side === 'LONG' ? (cur - pos.entry) * pos.amt : (pos.entry - cur) * pos.amt;
}
const netAt = (pos, cur) => grossAt(pos, cur) - pos.fees;
function totalNet(freshOnly){
  let sum = 0;
  for (const p of state.positions){
    const c = freshOnly ? freshFut(p.sym) : futPx(p.sym);
    if (c == null){ if (freshOnly) return null; continue; }
    sum += netAt(p, c);
  }
  return sum;
}
function lossGateOpen(){
  if (!normEnabled()) return true;
  if (state.positions.length === 0) return true;
  const nt = totalNet(true);
  if (nt == null) return false;
  return nt <= -normalizeLoss();
}

function findPosIndex(sym, side){
  const S = normSym(sym);
  return state.positions.findIndex(p => normSym(p.sym) === S && p.side === side);
}

function executeOpen(sym, side, amt, source, notional, forcedPx, spotRef){
  const S = normSym(sym);
  const price = (forcedPx != null && isFinite(forcedPx)) ? forcedPx : freshFut(S);
  if (price == null) return false;
  if (!isFinite(amt) || amt <= 0) return false;
  if (!notional) notional = amt * price;

  const f = feePct();
  const addFee = amt * price * f;
  const idx = findPosIndex(S, side);

  if (idx !== -1){
    const p = state.positions[idx];
    const oldAmt = p.amt, oldEntry = p.entry;
    const newAmt = oldAmt + amt;
    const newEntry = (oldEntry * oldAmt + price * amt) / newAmt;
    p.entry = newEntry; p.amt = newAmt; p.fees += addFee;
    p.adds = (p.adds || 1) + 1;
    p.notional = (p.notional || (oldAmt * oldEntry)) + notional;
    if (spotRef != null) p.spot = spotRef;
    log(`⟳ AVERAGE ${side} ${S}: ${amt.toFixed(4)} @ ${price} (×${p.adds})`, 'pos');
  } else {
    state.positions.push({
      id: state.posSeq++, sym: S, side, entry: price, amt, fees: addFee,
      adds: 1, notional, openedAt: Date.now(), spot: spotRef ?? spotPx(S) ?? null
    });
    const tag = source === 'auto' ? ' [gap]' : source === 'queue' ? ' [queued]' : '';
    log(`✚ OPEN ${side} ${S}: ${amt.toFixed(4)} @ ${price} ($${notional.toFixed(2)})${tag}`, 'pos');
  }
  saveState();
  return true;
}

function closePos(id, reason, usePx){
  const idx = state.positions.findIndex(p => p.id === id);
  if (idx < 0) return false;
  const p = state.positions[idx];
  let cur = (usePx != null && isFinite(usePx)) ? usePx : freshFut(p.sym);
  if (cur == null) cur = futPx(p.sym) ?? p.entry;

  const f = feePct();
  p.fees += p.amt * cur * f;
  const net = grossAt(p, cur) - p.fees;

  state.realizedPnl += net;
  state.realizedFees += p.fees;
  state.tradeCount++;
  if (net >= 0) state.wins++; else state.losses++;

  log(`${reason || 'CLOSE'} ${p.side} ${p.sym} → ${net>=0?'+':''}${net.toFixed(4)}`, net>=0 ? 'pos' : 'neg');

  state.positions.splice(idx, 1);
  saveState();
  return true;
}

function closeAll(reason){
  if (!state.positions.length) return false;
  [...state.positions].forEach(p => closePos(p.id, reason));
  return true;
}

function planEntry(sym, openNet){
  const sig = signalFor(sym);
  if (!sig) return null;
  const base = parseFloat(state.settings.amt);
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

/* ───────── WebSocket feeds ───────── */
let spotWs = null, futWs = null, spotRetry = 0, futRetry = 0;
const SPOT_WS = [
  s => 'wss://stream.binance.com:9443/stream?streams=' + s,
  s => 'wss://stream.binance.com:443/stream?streams=' + s
];
const FUT_WS = [
  s => 'wss://fstream.binance.com:443/stream?streams=' + s,
  s => 'wss://fstream.binance.com:443/market/' + s
];

function connectWs(){
  if (spotWs){ try{ spotWs.terminate(); }catch(e){} spotWs = null; }
  if (futWs){  try{ futWs.terminate();  }catch(e){} futWs  = null; }
  state.ws.spotOpen = false; state.ws.futOpen = false;

  const syms = [...state.symbols];
  if (!syms.length) return;
  const streams = syms.map(s => s.toLowerCase() + 'usdt@miniTicker').join('/');

  const trySpot = (ui) => {
    try { spotWs = new WebSocket(SPOT_WS[ui % SPOT_WS.length](streams)); }
    catch(e){ return setTimeout(() => trySpot(ui+1), 2000); }
    spotWs.on('open',    () => { state.ws.spotOpen = true; state.ws.lastMsg = Date.now(); });
    spotWs.on('message', data => { try {
      const m = JSON.parse(data); const d = m.data; if (!d || !d.s) return;
      const sym = normSym(d.s.endsWith('USDT') ? d.s.slice(0,-4) : d.s);
      const p = parseFloat(d.c);
      if (!isFinite(p) || p <= 0) return;
      state.ws.lastMsg = Date.now(); setSpot(sym, p);
    } catch(e){} });
    spotWs.on('close',   () => { state.ws.spotOpen = false; setTimeout(() => trySpot(ui+1), Math.min(15000, 1000*(spotRetry++ + 1))); });
    spotWs.on('error',   () => { try{ spotWs.terminate(); }catch(e){} });
  };
  const tryFut = (ui) => {
    try { futWs = new WebSocket(FUT_WS[ui % FUT_WS.length](streams)); }
    catch(e){ return setTimeout(() => tryFut(ui+1), 2000); }
    futWs.on('open',    () => { state.ws.futOpen = true; state.ws.lastMsg = Date.now(); });
    futWs.on('message', data => { try {
      const m = JSON.parse(data); const d = m.data; if (!d || !d.s) return;
      const sym = normSym(d.s.endsWith('USDT') ? d.s.slice(0,-4) : d.s);
      const p = parseFloat(d.c);
      if (!isFinite(p) || p <= 0) return;
      state.ws.lastMsg = Date.now(); setFut(sym, p);
    } catch(e){} });
    futWs.on('close',   () => { state.ws.futOpen = false; setTimeout(() => tryFut(ui+1), Math.min(15000, 1000*(futRetry++ + 1))); });
    futWs.on('error',   () => { try{ futWs.terminate(); }catch(e){} });
  };
  trySpot(0); tryFut(0);
}

/* ───────── REST fallbacks ───────── */
async function fetchTickSizes(){
  try {
    const r = await fetch('https://api.binance.com/api/v3/exchangeInfo');
    const j = await r.json();
    if (!j.symbols) return;
    let n = 0;
    for (const s of j.symbols){
      if (!s.symbol || !s.symbol.endsWith('USDT')) continue;
      if (s.status && s.status !== 'TRADING') continue;
      const sym = s.symbol.slice(0,-4);
      const f = (s.filters || []).find(x => x.filterType === 'PRICE_FILTER');
      if (f && f.tickSize){
        const t = parseFloat(f.tickSize);
        if (isFinite(t) && t > 0){ state.tickSizes[sym] = t; n++; }
      }
    }
    log(`📏 Loaded ${n} tick sizes`, 'pos');
  } catch(e){ log('📏 Tick sizes fallback', 'neg'); }
}
async function restSpotAll(){
  const wanted = new Set(state.symbols.map(normSym));
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr');
    if (!r.ok) return 0;
    const j = await r.json(); let n = 0;
    for (const t of j){
      if (!t || !t.symbol || !t.symbol.endsWith('USDT')) continue;
      const sym = t.symbol.slice(0,-4);
      if (!wanted.has(sym)) continue;
      if (setSpot(sym, parseFloat(t.lastPrice))) n++;
    }
    return n;
  } catch(e){ return 0; }
}
async function restFutAll(){
  const wanted = new Set(state.symbols.map(normSym));
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
    if (!r.ok) return 0;
    const j = await r.json(); let n = 0;
    for (const t of j){
      if (!t || !t.symbol || !t.symbol.endsWith('USDT')) continue;
      const sym = t.symbol.slice(0,-4);
      if (!wanted.has(sym)) continue;
      if (setFut(sym, parseFloat(t.lastPrice))) n++;
    }
    return n;
  } catch(e){ return 0; }
}
async function restSpot(sym){
  const S = normSym(sym) + 'USDT';
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=' + S);
    if (!r.ok) return null;
    const j = await r.json();
    const p = parseFloat(j.price);
    if (isFinite(p) && p > 0){ setSpot(sym, p); return p; }
  } catch(e){}
  return null;
}
async function restFut(sym){
  const S = normSym(sym) + 'USDT';
  try {
    const r = await fetch('https://fapi.binance.com/fapi/v1/ticker/price?symbol=' + S);
    if (!r.ok) return null;
    const j = await r.json();
    const p = parseFloat(j.price);
    if (isFinite(p) && p > 0){ setFut(sym, p); return p; }
  } catch(e){}
  return null;
}
async function restPriceBatch(syms){
  const uniq = [...new Set(syms.map(normSym))].filter(s => state.symbols.includes(s));
  if (!uniq.length) return;
  await Promise.all(uniq.map(async s => {
    if (isFresh(s, 800)) return;
    await Promise.all([restSpot(s), restFut(s)]);
  }));
  flushQueue();
}
function refreshStale(syms){
  const now = Date.now();
  const uniq = [...new Set(syms.map(normSym))].filter(s =>
    state.symbols.includes(s) && !isFresh(s) && (now - (state.lastRest[s]||0) > 1500));
  if (!uniq.length) return;
  uniq.forEach(s => state.lastRest[s] = now);
  restPriceBatch(uniq);
}

function flushQueue(){
  if (!state.queue.length) return;
  const now = Date.now();
  for (let i = state.queue.length - 1; i >= 0; i--){
    const q = state.queue[i];
    if (now - (q.at || 0) > QUEUE_TTL){ state.queue.splice(i,1); continue; }
    const price = freshFut(q.sym);
    if (price != null){
      if (gapEnabled() && !gapConfirms(q.sym, q.side).ok){ state.queue.splice(i,1); continue; }
      const qty = q.notional / price;
      if (executeOpen(q.sym, q.side, qty, 'queue', q.notional, price, spotPx(q.sym))) state.queue.splice(i,1);
    }
  }
}

/* ───────── Autopilot ───────── */
function autopilotTick(){
  if (!state.settings.autopilot) return;
  const syms = [...state.checked];
  if (!syms.length) return;

  const exitT = parseFloat(state.settings.apTarget);
  if (!isFinite(exitT) || exitT <= 0) return;

  const maxOpen = Math.max(1, parseInt(state.settings.maxOpen) || 5);
  const sl = parseFloat(state.settings.sl);

  [...state.positions].forEach(p => {
    const cur = freshFut(p.sym);
    if (cur == null) return;
    const net = netAt(p, cur);
    if (net >= exitT) closePos(p.id, `✅ +PnL EXIT ${net.toFixed(4)}`, cur);
  });

  const nt = totalNet(true);
  if (nt != null && isFinite(sl) && sl > 0 && nt <= -sl){
    log(`🛑 BASKET SL — net ${nt.toFixed(4)}`, 'neg');
    closeAll(`AP SL ${nt.toFixed(4)}`); return;
  }
  if (normEnabled() && nt != null && state.positions.length > 0 && nt >= normalizeProfit()){
    log(`🎯 NORM PROFIT — basket +${nt.toFixed(4)}`, 'pos');
    closeAll(`NORM PROFIT +${nt.toFixed(4)}`); return;
  }

  if (state.positions.length >= maxOpen) return;
  if (Date.now() - state.lastEntryAt < ENTRY_COOLDOWN) return;

  const openNet = totalNet(true) ?? 0;
  if (normEnabled() && state.positions.length > 0 && openNet > -normalizeLoss()) return;

  const openSyms = new Set(state.positions.map(p => normSym(p.sym)));
  const pool = syms.filter(s => !openSyms.has(normSym(s)));
  if (!pool.length) return;

  const candidates = [];
  for (const s of pool){
    if (!isFresh(s)){ refreshStale([s]); continue; }
    const sig = signalFor(s);
    if (!sig) continue;
    const price = freshFut(s);
    if (price == null) continue;
    const g = gapConfirms(s, sig.side);
    if (gapEnabled() && !g.ok) continue;
    candidates.push({ sym: s, price, absGap: Math.abs(sig.gap), side: sig.side, gapTicks: g.ticks });
  }
  if (!candidates.length) return;

  candidates.sort((a,b) => b.absGap - a.absGap);
  const pick = candidates[0];
  const plan = planEntry(pick.sym, openNet);
  if (!plan) return;

  const qty = plan.notional / pick.price;
  if (executeOpen(pick.sym, plan.side, qty, 'auto', plan.notional, pick.price, plan.spot)){
    state.apCycles++;
    state.lastEntryAt = Date.now();
    log(`🤖 GAP ${pick.sym}: ${plan.side} $${plan.notional.toFixed(2)} · gap ${pick.gapTicks?.toFixed(1)}t · ${candidates.length} confirmed`, 'pos');
  }
}

function checkDrift(){
  if (!state.positions.length) return;
  const up = parseFloat(state.settings.driftUp);
  const dn = parseFloat(state.settings.driftDn);
  const upT = (isFinite(up) && up > 0) ? up : null;
  const dnT = (isFinite(dn) && dn > 0) ? dn : null;
  if (upT == null && dnT == null) return;
  const nt = totalNet(true);
  if (nt == null){ refreshStale(state.positions.map(p => p.sym)); return; }
  if (upT != null && nt >= upT){ log(`⚠ +DRIFT`, 'neg'); closeAll(`+DRIFT ${nt.toFixed(4)}`); }
  else if (dnT != null && nt <= -dnT){ log(`⚠ −DRIFT`, 'neg'); closeAll(`−DRIFT ${nt.toFixed(4)}`); }
}
function checkManualExits(){
  if (!state.positions.length || state.settings.autopilot) return;
  const tp = parseFloat(state.settings.tp);
  const sl = parseFloat(state.settings.sl);
  const tpAmt = (isFinite(tp) && tp > 0) ? tp : null;
  const slAmt = (isFinite(sl) && sl > 0) ? sl : null;
  if (tpAmt == null && slAmt == null) return;
  [...state.positions].forEach(p => {
    const cur = freshFut(p.sym);
    if (cur == null) return;
    const net = netAt(p, cur);
    if (tpAmt != null && net >= tpAmt) closePos(p.id, 'TP HIT', cur);
    else if (slAmt != null && net <= -slAmt) closePos(p.id, 'SL HIT', cur);
  });
}

/* ───────── Persistence ───────── */
function saveState(){
  try {
    const toSave = {
      symbols: state.symbols, checked: state.checked, positions: state.positions,
      sessionStart: state.sessionStart, realizedPnl: state.realizedPnl,
      realizedFees: state.realizedFees, tradeCount: state.tradeCount,
      wins: state.wins, losses: state.losses, posSeq: state.posSeq,
      settings: state.settings
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave));
  } catch(e){ console.error('saveState:', e.message); }
}
function loadState(){
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Array.isArray(d.symbols) && d.symbols.length) state.symbols = d.symbols;
    if (Array.isArray(d.checked)) state.checked = d.checked;
    if (Array.isArray(d.positions)) state.positions = d.positions;
    if (d.sessionStart) state.sessionStart = d.sessionStart;
    if (d.realizedPnl  != null) state.realizedPnl  = d.realizedPnl;
    if (d.realizedFees != null) state.realizedFees = d.realizedFees;
    if (d.tradeCount   != null) state.tradeCount   = d.tradeCount;
    if (d.wins   != null) state.wins   = d.wins;
    if (d.losses != null) state.losses = d.losses;
    if (d.posSeq != null) state.posSeq = d.posSeq;
    if (d.settings) Object.assign(state.settings, d.settings);
    log('♻ State restored from disk', 'pos');
  } catch(e){ console.error('loadState:', e.message); }
}

/* ───────── API + UI ───────── */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

app.get('/api/state', (_req, res) => {
  res.json({
    symbols: state.symbols, checked: state.checked,
    spot: state.spot, fut: state.fut, tickAt: state.tickAt,
    positions: state.positions, queue: state.queue,
    sessionStart: state.sessionStart, realizedPnl: state.realizedPnl,
    realizedFees: state.realizedFees, tradeCount: state.tradeCount,
    wins: state.wins, losses: state.losses, posSeq: state.posSeq,
    settings: state.settings,
    logs: state.logs.slice(0, 60),
    lastTickAt: state.lastTickAt,
    ws: { spotOpen: state.ws.spotOpen, futOpen: state.ws.futOpen },
    server: { now: Date.now(), uptime: process.uptime() }
  });
});

app.post('/api/settings', (req, res) => {
  Object.assign(state.settings, req.body || {});
  saveState();
  res.json({ ok: true });
});

app.post('/api/symbols', (req, res) => {
  const { action, symbol } = req.body || {};
  const S = normSym(symbol);
  if (!S) return res.json({ ok: false, error: 'bad symbol' });
  if (action === 'add'){
    if (!state.symbols.includes(S)) state.symbols.push(S);
    if (!state.checked.includes(S)) state.checked.push(S);
    connectWs(); saveState();
  } else if (action === 'remove'){
    if (state.positions.some(p => normSym(p.sym) === S))
      return res.json({ ok: false, error: 'close positions first' });
    state.symbols = state.symbols.filter(s => s !== S);
    state.checked = state.checked.filter(s => s !== S);
    state.queue = state.queue.filter(q => normSym(q.sym) !== S);
    connectWs(); saveState();
  } else if (action === 'toggle'){
    if (state.checked.includes(S)) state.checked = state.checked.filter(x => x !== S);
    else if (state.symbols.includes(S)) state.checked.push(S);
    saveState();
  }
  res.json({ ok: true });
});

app.post('/api/open', async (req, res) => {
  const { side, symbol } = req.body || {};
  if (!['LONG','SHORT'].includes(side)) return res.json({ ok: false, error: 'bad side' });
  const notional = parseFloat(state.settings.amt);
  if (!isFinite(notional) || notional <= 0) return res.json({ ok: false, error: 'bad amt' });
  const target = symbol ? [normSym(symbol)] : [...state.checked];
  let opened = 0; const stale = [];
  for (const s of target){
    if (gapEnabled() && !gapConfirms(s, side).ok) continue;
    const price = freshFut(s);
    if (price != null){
      if (executeOpen(s, side, notional / price, 'manual', notional, price, spotPx(s))) opened++;
    } else stale.push(s);
  }
  if (stale.length){
    await restPriceBatch(stale);
    for (const s of stale){
      const price = freshFut(s);
      if (price != null) { if (executeOpen(s, side, notional/price, 'manual', notional, price, spotPx(s))) opened++; }
      else if (!state.queue.some(q => normSym(q.sym) === s && q.side === side))
        state.queue.push({ sym: s, side, notional, at: Date.now() });
    }
  }
  res.json({ ok: true, opened });
});

app.post('/api/close/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  res.json({ ok: closePos(id, '✕ manual') });
});

app.post('/api/exit-all', (_req, res) => {
  state.queue = [];
  state.settings.autopilot = false;
  closeAll('EXIT ALL');
  saveState();
  res.json({ ok: true });
});

app.post('/api/reset-session', (_req, res) => {
  state.sessionStart = Date.now();
  state.realizedPnl = 0; state.realizedFees = 0;
  state.tradeCount = 0; state.wins = 0; state.losses = 0;
  saveState();
  res.json({ ok: true });
});

/* ───────── Main loops ───────── */
setInterval(() => {
  try { autopilotTick(); checkManualExits(); checkDrift(); flushQueue(); }
  catch(e){ console.error('tick:', e.message); }
}, 1000);

setInterval(async () => {
  if (state.restBusy) return;
  state.restBusy = true;
  try { await Promise.all([restSpotAll(), restFutAll()]); flushQueue(); }
  finally { state.restBusy = false; }
}, 5000);

setInterval(() => {
  if (!state.symbols.length) return;
  if (Date.now() - state.ws.lastMsg > WS_SILENT){
    log('Watchdog: reconnecting WS', 'neg');
    connectWs();
  }
}, 10000);

setInterval(saveState, 3000);

/* ───────── Boot ───────── */
app.listen(PORT, () => {
  console.log('Delta Neutral server-side engine listening on', PORT);
  loadState();
  connectWs();
  fetchTickSizes();
  setTimeout(() => Promise.all([restSpotAll(), restFutAll()]), 2000);
});
