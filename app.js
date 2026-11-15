/* AI Crypto Trader — PAPER TRADING SIMULATOR (no real money).
   Live prices: Binance public REST first, CoinGecko public API as fallback.
   Signal engine: rule-based EMA/RSI/MACD/volume — labelled honestly in the UI. */
'use strict';

const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const CG_IDS = { BTCUSDT: 'bitcoin', ETHUSDT: 'ethereum', SOLUSDT: 'solana', BNBUSDT: 'binancecoin', XRPUSDT: 'ripple', DOGEUSDT: 'dogecoin' };
const FEE = 0.001; // 0.1% per trade
const LS_KEY = 'ai-crypto-trader-v1';
const STRATEGIES = {
  conservative: { buy: 72, sell: 28, label: 'Conservative' },
  balanced:     { buy: 62, sell: 38, label: 'Balanced' },
  aggressive:   { buy: 56, sell: 44, label: 'Aggressive' }
};

/* ---------------- state ---------------- */
const DEFAULTS = {
  settings: { budget: 1000, targetPct: 20, hours: 24, customHours: 12, maxTradePct: 25, stopLossPct: 5, takeProfitPct: 10, strategy: 'balanced', autoTrade: true, intervalSec: 60 },
  pair: 'BTCUSDT',
  session: null // {status, startedAt, endsAt, pausedAt, initial, cash, qty, entry, pair, trades:[], fees:0, endReason, endLabel}
};
let settings = { ...DEFAULTS.settings };
let pair = DEFAULTS.pair;
let session = null;
let prices = {};      // pair -> {price, change24h}
let candles = [];     // {t,o,h,l,c,v} for selected pair
let lastSignal = { score: 50, signal: 'HOLD', confidence: 0, reason: 'Waiting for data…', rsi: null, emaBull: null, macdHist: null, volRatio: null };
let dataSource = '—';
let lastAutoCheck = 0;

/* ---------------- helpers ---------------- */
const $ = id => document.getElementById(id);
const fmt$ = n => '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPrice = p => p >= 1000 ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  : p >= 1 ? p.toFixed(4) : p.toFixed(6);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const now = () => Date.now();

function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ settings, pair, session })); } catch (e) { /* storage unavailable */ }
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    if (d.settings) settings = { ...DEFAULTS.settings, ...d.settings };
    if (d.pair && PAIRS.includes(d.pair)) pair = d.pair;
    if (d.session) session = d.session;
  } catch (e) { /* ignore corrupt state */ }
}

/* ---------------- indicators (pure, testable) ---------------- */
function emaSeries(values, period) {
  const k = 2 / (period + 1);
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}
function lastEma(values, period) {
  const s = emaSeries(values, period);
  return s[s.length - 1];
}
function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}
function macd(closes) {
  const e12 = emaSeries(closes, 12), e26 = emaSeries(closes, 26);
  const line = closes.map((_, i) => (e12[i] == null || e26[i] == null) ? null : e12[i] - e26[i]);
  const valid = line.filter(v => v != null);
  const sigSeries = emaSeries(valid, 9);
  const sig = sigSeries[sigSeries.length - 1];
  const last = line[line.length - 1];
  if (last == null || sig == null) return null;
  return { line: last, signal: sig, hist: last - sig };
}
function volumeRatio(vols, period = 20) {
  if (vols.length < period + 1) return null;
  const recent = vols.slice(-period - 1, -1);
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (avg === 0) return null;
  return vols[vols.length - 1] / avg;
}

/* ---------------- signal engine ---------------- */
function computeSignal() {
  const closes = candles.map(c => c.c);
  const vols = candles.map(c => c.v);
  if (closes.length < 30) return lastSignal;
  const e12 = lastEma(closes, 12), e26 = lastEma(closes, 26);
  const r = rsi(closes, 14);
  const m = macd(closes);
  const vr = volumeRatio(vols, 20);
  let score = 50;
  const reasons = [];
  if (e12 != null && e26 != null) {
    if (e12 > e26) { score += 25; reasons.push('EMA bullish'); }
    else if (e12 < e26) { score -= 25; reasons.push('EMA bearish'); }
    else reasons.push('EMA flat');
  }
  if (m) {
    if (m.hist > 0) { score += 15; reasons.push('MACD positive'); }
    else if (m.hist < 0) { score -= 15; reasons.push('MACD negative'); }
    else reasons.push('MACD flat');
  }
  if (r != null) {
    if (r < 30) { score += 15; reasons.push('RSI ' + r.toFixed(0) + ' oversold'); }
    else if (r < 50) { score += 5; reasons.push('RSI ' + r.toFixed(0)); }
    else if (r > 70) { score -= 15; reasons.push('RSI ' + r.toFixed(0) + ' overbought'); }
    else reasons.push('RSI ' + r.toFixed(0));
  }
  if (vr != null) {
    if (vr > 1.5) { score += 10; reasons.push('volume ' + vr.toFixed(1) + 'x avg'); }
    else if (vr > 1.2) { score += 5; reasons.push('volume ' + vr.toFixed(1) + 'x avg'); }
    else reasons.push('volume ' + vr.toFixed(1) + 'x avg');
  }
  score = clamp(Math.round(score), 0, 100);
  const t = STRATEGIES[settings.strategy] || STRATEGIES.balanced;
  const signal = score >= t.buy ? 'BUY' : score <= t.sell ? 'SELL' : 'HOLD';
  const confidence = Math.round(Math.abs(score - 50) * 2);
  lastSignal = { score, signal, confidence, reason: reasons.join(' · '), rsi: r, emaBull: e12 != null && e26 != null ? e12 > e26 : null, macdHist: m ? m.hist : null, volRatio: vr };
  return lastSignal;
}

/* ---------------- data fetching ---------------- */
async function fetchPrices() {
  // Try Binance first (all 6 pairs in one call)
  try {
    const sym = encodeURIComponent(JSON.stringify(PAIRS));
    const res = await fetch('https://api.binance.com/api/v3/ticker/price?symbols=' + sym);
    const data = await res.json();
    if (Array.isArray(data) && data.length) {
      data.forEach(d => { if (prices[d.symbol]) prices[d.symbol].price = parseFloat(d.price); else prices[d.symbol] = { price: parseFloat(d.price), change24h: null }; });
      // 24h change, second call
      const r2 = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbols=' + sym);
      const d2 = await r2.json();
      if (Array.isArray(d2)) d2.forEach(d => { if (prices[d.symbol]) prices[d.symbol].change24h = parseFloat(d.priceChangePercent); });
      dataSource = 'Binance (live)';
      return;
    }
    throw new Error('Binance returned no data');
  } catch (e) { /* fall through to CoinGecko */ }
  try {
    const ids = Object.values(CG_IDS).join(',');
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=' + ids + '&vs_currencies=usd&include_24hr_change=true');
    const data = await res.json();
    PAIRS.forEach(p => {
      const g = data[CG_IDS[p]];
      if (g) prices[p] = { price: g.usd, change24h: g.usd_24h_change != null ? g.usd_24h_change : null };
    });
    dataSource = 'CoinGecko (live)';
  } catch (e) {
    dataSource = 'Price feed offline — retrying…';
  }
}

async function fetchKlines() {
  try {
    const res = await fetch('https://api.binance.com/api/v3/klines?symbol=' + pair + '&interval=1m&limit=100');
    const data = await res.json();
    if (Array.isArray(data) && data.length > 30) {
      candles = data.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      return;
    }
    throw new Error('Binance klines empty');
  } catch (e) { /* fallback */ }
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/' + CG_IDS[pair] + '/market_chart?vs_currency=usd&days=1&interval=hourly');
    const data = await res.json();
    const pts = (data.prices || []).map(p => ({ t: p[0], c: p[1] }));
    if (pts.length > 30) {
      candles = pts.map((p, i) => ({ t: p.t, o: i ? pts[i - 1].c : p.c, h: p.c, l: p.c, c: p.c, v: 0 }));
      return;
    }
  } catch (e) { /* keep old candles */ }
}

/* ---------------- trading ---------------- */
function currentPrice() { return prices[pair] ? prices[pair].price : null; }
function portfolioValue() {
  if (!session) return 0;
  const p = currentPrice();
  return session.cash + (session.qty > 0 && p ? session.qty * p : 0);
}
function isRunning() { return session && session.status === 'running'; }

function addTrade(trade) {
  session.trades.unshift(trade);
  if (session.trades.length > 200) session.trades.length = 200;
}

function executeBuy(note) {
  const p = currentPrice();
  if (!p || !isRunning()) return;
  const size = Math.min(session.cash * settings.maxTradePct / 100, session.cash);
  if (size < 10) return; // too small to bother
  const fee = size * FEE;
  const qty = (size - fee) / p;
  session.cash -= size;
  session.qty += qty;
  session.entry = p; // single-position model: last buy price is the entry
  session.fees += fee;
  addTrade({ t: now(), pair, side: 'BUY', price: p, size, fee, pnl: null, note, idx: candles.length - 1 });
  save();
}

function executeSell(note) {
  const p = currentPrice();
  if (!p || !isRunning() || session.qty <= 0) return;
  const gross = session.qty * p;
  const fee = gross * FEE;
  const net = gross - fee;
  const cost = session.qty * (session.entry || p);
  const pnl = net - cost;
  session.cash += net;
  session.fees += fee;
  addTrade({ t: now(), pair, side: 'SELL', price: p, size: gross, fee, pnl, note, idx: candles.length - 1 });
  session.qty = 0;
  session.entry = null;
  save();
}

function autoTradeCheck() {
  if (!isRunning() || !settings.autoTrade) return;
  const p = currentPrice();
  if (!p) return;
  // Position management first: take-profit / stop-loss
  if (session.qty > 0 && session.entry) {
    if (p >= session.entry * (1 + settings.takeProfitPct / 100)) { executeSell('Take-profit +' + settings.takeProfitPct + '%'); return; }
    if (p <= session.entry * (1 - settings.stopLossPct / 100)) { executeSell('Stop-loss −' + settings.stopLossPct + '%'); return; }
  }
  const s = lastSignal;
  if (session.qty <= 0 && s.signal === 'BUY') executeBuy('AI BUY · score ' + s.score);
  else if (session.qty > 0 && s.signal === 'SELL') executeSell('AI SELL · score ' + s.score);
}

function endSession(win, reason) {
  if (!session || session.status === 'ended') return;
  // Close any open position at the live price first
  if (session.qty > 0) executeSell('Session end');
  session.status = 'ended';
  session.endReason = reason;
  session.endLabel = win ? 'WIN' : 'LOSS';
  save();
  renderAll();
}

function checkEndConditions() {
  if (!isRunning()) return;
  const val = portfolioValue();
  const pnlPct = (val - session.initial) / session.initial * 100;
  if (pnlPct >= settings.targetPct) { endSession(true, 'Target +' + settings.targetPct + '% hit'); return; }
  if (pnlPct <= -settings.stopLossPct) { endSession(false, 'Capital stop-loss −' + settings.stopLossPct + '% hit'); return; }
  if (now() >= session.endsAt) {
    endSession(pnlPct >= settings.targetPct, 'Time limit reached');
  }
}

/* ---------------- session controls ---------------- */
function readSettingsFromUI() {
  settings.budget = Math.max(10, parseFloat($('setBudget').value) || 1000);
  settings.targetPct = Math.max(1, parseFloat($('setTarget').value) || 20);
  const hSel = $('setHours').value;
  settings.hours = hSel === 'custom' ? Math.max(1, parseFloat($('setCustomHours').value) || 12) : parseInt(hSel, 10);
  settings.maxTradePct = clamp(parseFloat($('setMaxTrade').value) || 25, 1, 100);
  settings.stopLossPct = Math.max(0.5, parseFloat($('setSL').value) || 5);
  settings.takeProfitPct = Math.max(0.5, parseFloat($('setTP').value) || 10);
  settings.intervalSec = parseInt($('setInterval').value, 10);
  settings.autoTrade = $('setAutoTrade').checked;
  save();
}

function startSession() {
  readSettingsFromUI();
  const p = currentPrice();
  if (!p) { alert('Waiting for live price — try again in a few seconds.'); return; }
  session = {
    status: 'running', startedAt: now(), endsAt: now() + settings.hours * 3600 * 1000,
    pausedAt: null, initial: settings.budget, cash: settings.budget, qty: 0, entry: null,
    pair, trades: [], fees: 0, endReason: null, endLabel: null
  };
  lastAutoCheck = 0;
  save();
  renderAll();
}
function pauseSession() {
  if (!session) return;
  if (session.status === 'running') { session.status = 'paused'; session.pausedAt = now(); }
  else if (session.status === 'paused') { session.endsAt += now() - session.pausedAt; session.pausedAt = null; session.status = 'running'; }
  save();
  renderAll();
}
function resetSession() {
  session = null;
  save();
  renderAll();
}

/* ---------------- rendering ---------------- */
function renderPairs() {
  const wrap = $('pairButtons');
  wrap.innerHTML = '';
  PAIRS.forEach(p => {
    const b = document.createElement('button');
    b.textContent = p.replace('USDT', '/USDT');
    if (p === pair) b.classList.add('active');
    b.disabled = isRunning() || (session && session.status === 'paused');
    b.title = isRunning() ? 'Pair is locked while a session runs' : '';
    b.onclick = () => { pair = p; candles = []; save(); fetchKlines().then(renderAll); renderAll(); };
    wrap.appendChild(b);
  });
  $('pairLabel').textContent = pair.replace('USDT', '/USDT');
}

function renderPrice() {
  const d = prices[pair];
  if (!d) return;
  $('livePrice').textContent = '$' + fmtPrice(d.price);
  const ch = $('liveChange');
  if (d.change24h != null) {
    ch.textContent = (d.change24h >= 0 ? '▲ +' : '▼ ') + d.change24h.toFixed(2) + '% (24h)';
    ch.className = 'lp-change ' + (d.change24h >= 0 ? 'up' : 'down');
  } else { ch.textContent = ''; }
  $('dataSource').textContent = '● ' + dataSource;
}

function renderSignal() {
  const s = lastSignal;
  $('aiScore').textContent = s.score;
  $('scoreFill').style.width = s.score + '%';
  const badge = $('signalBadge');
  badge.textContent = s.signal;
  badge.className = 'signal ' + s.signal.toLowerCase();
  $('confidence').textContent = 'Confidence ' + s.confidence + '%';
  $('signalReason').textContent = s.reason;
  $('indEma').textContent = s.emaBull == null ? '—' : s.emaBull ? 'Bullish ▲' : 'Bearish ▼';
  $('indRsi').textContent = s.rsi == null ? '—' : s.rsi.toFixed(1) + (s.rsi > 70 ? ' (overbought)' : s.rsi < 30 ? ' (oversold)' : '');
  $('indMacd').textContent = s.macdHist == null ? '—' : (s.macdHist >= 0 ? '+' : '') + s.macdHist.toFixed(2);
  $('indVol').textContent = s.volRatio == null ? '—' : s.volRatio.toFixed(2) + 'x avg';
  document.querySelectorAll('#strategySeg button').forEach(b => b.classList.toggle('active', b.dataset.strategy === settings.strategy));
}

function renderPortfolio() {
  const banner = $('resultBanner');
  if (session && session.status === 'ended') {
    const val = portfolioValue();
    const pnl = val - session.initial;
    const pct = pnl / session.initial * 100;
    banner.className = 'banner ' + (session.endLabel === 'WIN' ? 'win' : 'lose');
    banner.textContent = (session.endLabel === 'WIN' ? '🏆 WIN — ' : '📉 LOSS — ') + session.endReason +
      ' · Final ' + fmt$(val) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
    banner.classList.remove('hidden');
  } else if (session && session.status === 'paused') {
    banner.className = 'banner info';
    banner.textContent = '⏸ Session paused — countdown is frozen.';
    banner.classList.remove('hidden');
  } else banner.classList.add('hidden');

  if (!session) {
    $('pfStart').textContent = fmt$(settings.budget);
    $('pfValue').textContent = fmt$(settings.budget);
    $('pfPnl').textContent = '$0.00 (0.00%)';
    $('pfPnl').className = 'neutral';
    $('pfCash').textContent = fmt$(settings.budget);
    $('pfHold').textContent = '—';
    $('pfTime').textContent = '—';
    $('progressFill').style.width = '0%';
    $('progressPct').textContent = '0%';
    $('targetLabel').textContent = '+' + settings.targetPct + '%';
    $('stTrades').textContent = '0';
    $('stWins').textContent = '0';
    $('stWinRate').textContent = '—';
    $('stFees').textContent = '$0.00';
    return;
  }
  const val = portfolioValue();
  const pnl = val - session.initial;
  const pct = pnl / session.initial * 100;
  $('pfStart').textContent = fmt$(session.initial);
  $('pfValue').textContent = fmt$(val);
  $('pfPnl').textContent = (pnl >= 0 ? '+' : '') + fmt$(pnl) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%)';
  $('pfPnl').className = pnl >= 0 ? 'up' : 'down';
  $('pfCash').textContent = fmt$(session.cash);
  const p = currentPrice();
  $('pfHold').textContent = session.qty > 0 && p
    ? session.qty.toFixed(6) + ' ' + pair.replace('USDT', '') + ' @ $' + fmtPrice(session.entry) + ' (' + fmt$(session.qty * p) + ')'
    : '—';
  if (session.status === 'ended') $('pfTime').textContent = 'Ended';
  else {
    const ms = Math.max(0, session.endsAt - now());
    const h = Math.floor(ms / 3600000), m = Math.floor(ms % 3600000 / 60000), s2 = Math.floor(ms % 60000 / 1000);
    $('pfTime').textContent = h + 'h ' + String(m).padStart(2, '0') + 'm ' + String(s2).padStart(2, '0') + 's';
  }
  const prog = clamp(pct / settings.targetPct * 100, -100, 100);
  $('progressFill').style.width = Math.max(0, prog) + '%';
  $('progressFill').style.background = prog >= 100 ? 'var(--green)' : prog < 0 ? 'var(--red)' : 'var(--amber)';
  $('progressPct').textContent = Math.round(prog) + '%';
  $('targetLabel').textContent = '+' + settings.targetPct + '%';
  const sells = session.trades.filter(t => t.side === 'SELL');
  const wins = sells.filter(t => t.pnl != null && t.pnl > 0).length;
  $('stTrades').textContent = session.trades.length;
  $('stWins').textContent = wins;
  $('stWinRate').textContent = sells.length ? Math.round(wins / sells.length * 100) + '%' : '—';
  $('stFees').textContent = fmt$(session.fees);
}

function renderTrades() {
  const body = $('tradeBody');
  if (!session || !session.trades.length) {
    body.innerHTML = '<tr><td colspan="8" class="muted center">No trades yet.</td></tr>';
    return;
  }
  body.innerHTML = session.trades.map(t => {
    const d = new Date(t.t);
    const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const pnl = t.pnl == null ? '—' : (t.pnl >= 0 ? '+' : '') + fmt$(t.pnl);
    const pnlCls = t.pnl == null ? '' : t.pnl >= 0 ? 'up' : 'down';
    return '<tr><td>' + time + '</td><td>' + t.pair + '</td><td class="' + t.side.toLowerCase() + '">' + t.side + '</td>' +
      '<td>$' + fmtPrice(t.price) + '</td><td>' + fmt$(t.size) + '</td><td>' + fmt$(t.fee) + '</td>' +
      '<td class="' + pnlCls + '">' + pnl + '</td><td>' + (t.note || '') + '</td></tr>';
  }).join('');
}

function drawChart() {
  const cv = $('chart');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  if (candles.length < 2) {
    ctx.fillStyle = '#8b93a7'; ctx.font = '14px system-ui';
    ctx.fillText('Loading chart…', 20, H / 2);
    return;
  }
  const closes = candles.map(c => c.c);
  const min = Math.min(...closes), max = Math.max(...closes);
  const pad = (max - min) * 0.1 || 1;
  const lo = min - pad, hi = max + pad;
  const x = i => 8 + i / (closes.length - 1) * (W - 16);
  const y = v => H - 12 - (v - lo) / (hi - lo) * (H - 24);
  // grid lines
  ctx.strokeStyle = '#1c2438'; ctx.lineWidth = 1;
  for (let g = 0; g < 4; g++) {
    const gy = 12 + g * (H - 24) / 3;
    ctx.beginPath(); ctx.moveTo(8, gy); ctx.lineTo(W - 8, gy); ctx.stroke();
  }
  // line
  const up = closes[closes.length - 1] >= closes[0];
  ctx.strokeStyle = up ? '#22c55e' : '#ef4444'; ctx.lineWidth = 2; ctx.beginPath();
  closes.forEach((v, i) => i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v)));
  ctx.stroke();
  // last price dot
  ctx.fillStyle = up ? '#22c55e' : '#ef4444';
  ctx.beginPath(); ctx.arc(x(closes.length - 1), y(closes[closes.length - 1]), 4, 0, Math.PI * 2); ctx.fill();
  // buy/sell markers
  if (session) session.trades.forEach(t => {
    if (t.idx == null || t.idx >= closes.length) return;
    const mx = x(t.idx), my = y(closes[t.idx]);
    ctx.fillStyle = t.side === 'BUY' ? '#22c55e' : '#ef4444';
    ctx.beginPath();
    if (t.side === 'BUY') { ctx.moveTo(mx, my - 12); ctx.lineTo(mx - 6, my - 2); ctx.lineTo(mx + 6, my - 2); }
    else { ctx.moveTo(mx, my + 12); ctx.lineTo(mx - 6, my + 2); ctx.lineTo(mx + 6, my + 2); }
    ctx.closePath(); ctx.fill();
  });
  $('chartMeta').textContent = candles.length + ' × 1m candles · ' + (dataSource.includes('Binance') ? 'Binance' : 'CoinGecko');
}

function renderAll() {
  renderPairs();
  renderPrice();
  renderSignal();
  renderPortfolio();
  renderTrades();
  drawChart();
  const running = isRunning();
  const paused = session && session.status === 'paused';
  $('btnStart').disabled = running || paused;
  $('btnStart').textContent = session && session.status === 'ended' ? '▶ Start new session' : '▶ Start';
  $('btnPause').disabled = !session || session.status === 'ended';
  $('btnPause').textContent = paused ? '▶ Resume' : '⏸ Pause';
  $('btnBuy').disabled = !running;
  $('btnSell').disabled = !running || !session || session.qty <= 0;
}

/* ---------------- loops ---------------- */
async function priceTick() {
  await fetchPrices();
  renderPrice();
  renderPortfolio();
  // keep last candle in sync with live price
  if (candles.length) {
    const p = currentPrice();
    if (p) { const last = candles[candles.length - 1]; last.c = p; last.h = Math.max(last.h, p); last.l = Math.min(last.l, p); }
  }
  drawChart();
}
async function signalTick() {
  await fetchKlines();
  computeSignal();
  renderSignal();
  drawChart();
}
function secondTick() {
  $('clock').textContent = new Date().toLocaleTimeString('en-GB');
  if (!session) return;
  if (session.status === 'ended') return;
  if (session.status === 'running') {
    checkEndConditions();
    if (now() - lastAutoCheck >= settings.intervalSec * 1000) {
      lastAutoCheck = now();
      autoTradeCheck();
    }
  }
  renderPortfolio();
  renderTrades();
  renderAllButtonsOnly();
}
function renderAllButtonsOnly() {
  const running = isRunning();
  $('btnStart').disabled = running || (session && session.status === 'paused');
  $('btnPause').disabled = !session || session.status === 'ended';
  $('btnSell').disabled = !running || !session || session.qty <= 0;
  $('btnBuy').disabled = !running;
}

/* ---------------- wire up ---------------- */
function bindSettings() {
  const ids = ['setBudget', 'setTarget', 'setMaxTrade', 'setSL', 'setTP', 'setInterval', 'setAutoTrade', 'setCustomHours'];
  ids.forEach(id => $(id).addEventListener('change', () => { readSettingsFromUI(); renderPortfolio(); }));
  $('setHours').addEventListener('change', () => {
    $('customHoursWrap').classList.toggle('hidden', $('setHours').value !== 'custom');
    readSettingsFromUI();
  });
  document.querySelectorAll('#strategySeg button').forEach(b => b.addEventListener('click', () => {
    settings.strategy = b.dataset.strategy;
    save(); computeSignal(); renderSignal();
  }));
  $('btnStart').onclick = startSession;
  $('btnPause').onclick = pauseSession;
  $('btnReset').onclick = () => { if (!session || confirm('Reset the session? Trade history will be cleared.')) resetSession(); };
  $('btnBuy').onclick = () => executeBuy('Manual buy');
  $('btnSell').onclick = () => executeSell('Manual sell');
  $('btnClearHist').onclick = () => { if (session) { session.trades = []; save(); renderTrades(); } };
}

function fillSettingsUI() {
  $('setBudget').value = settings.budget;
  $('setTarget').value = settings.targetPct;
  $('setMaxTrade').value = settings.maxTradePct;
  $('setSL').value = settings.stopLossPct;
  $('setTP').value = settings.takeProfitPct;
  $('setInterval').value = String(settings.intervalSec);
  $('setAutoTrade').checked = settings.autoTrade;
  const std = [1, 24, 168, 720].includes(settings.hours);
  $('setHours').value = std ? String(settings.hours) : 'custom';
  $('setCustomHours').value = settings.customHours;
  $('customHoursWrap').classList.toggle('hidden', std);
}

async function init() {
  load();
  fillSettingsUI();
  bindSettings();
  renderAll();
  await priceTick();
  await signalTick();
  renderAll();
  setInterval(priceTick, 3000);
  setInterval(signalTick, 60000);
  setInterval(secondTick, 1000);
  setInterval(save, 10000);
}

document.addEventListener('DOMContentLoaded', init);
