/* TradeLens: real-time crypto analysis + learning. No build step, no API key. */
'use strict';
if (!Array.prototype.at) Array.prototype.at = function (i) { i = Math.trunc(i) || 0; if (i < 0) i += this.length; return this[i]; };

const NAMES = { BTC: 'Bitcoin', ETH: 'Ethereum', BNB: 'BNB', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano', DOGE: 'Dogecoin', AVAX: 'Avalanche', LINK: 'Chainlink', DOT: 'Polkadot', LTC: 'Litecoin', TRX: 'TRON' };
const TZ_SHIFT = -new Date().getTimezoneOffset() * 60; // show chart times in local time

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const base = (s) => s.replace(/USDT?$/, '');
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

const EX_KEY = 'tradelens_exchange_v1';
const initialEx = (() => {
  const q = new URLSearchParams(location.search).get('ex');
  if (q && EXCHANGES[q]) return q;
  try { const s = localStorage.getItem(EX_KEY); if (s && EXCHANGES[s]) return s; } catch {}
  return 'binance';
})();

const state = {
  ex: initialEx,
  tickers: {},
  symbol: 'BTC',
  interval: '1h',
  candles: [],
  highlight: null,
};

/* ---------- formatting ---------- */
function dp(p) { return p >= 1000 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 7; }
const fmtP = (p) => (p == null || isNaN(p) ? '—' : Number(p).toLocaleString(undefined, { minimumFractionDigits: dp(p), maximumFractionDigits: dp(p) }));
const fmtUsd = (v) => (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v) => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
const fmtCompact = (v) => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(v);
const fmtQty = (q) => q.toLocaleString(undefined, { maximumFractionDigits: q >= 1 ? 4 : 6 });
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

const EX = () => EXCHANGES[state.ex];
const pair = (a) => `${a} / ${EX().quote}`;

/* ---------- connection status ---------- */
onSocketStatus = function updateStatus() {
  const open = Object.values(sockets).some((s) => s.isOpen);
  const any = Object.keys(sockets).length;
  $('#liveDot').className = 'dot ' + (open ? 'on' : any ? 'off' : '');
  $('#liveText').textContent = open ? `Live · ${EX().name}${routes[state.ex] === 'relay' ? ' (relay)' : ''}` : 'Reconnecting…';
};
function explainError(ex, e) {
  const st = e && e.status;
  if (st === 403 || st === 451) return `${ex.name} refused the connection (HTTP ${st}). ${ex.name} blocks some countries and networks, including some VPNs and iPhone "iCloud Private Relay". Turn those off or pick another exchange from the menu at the top.`;
  if (st === 429) return `${ex.name} is rate-limiting this network (HTTP 429). Wait a minute or pick another exchange.`;
  if (st) return `${ex.name} returned an error (HTTP ${st}). Try again shortly or pick another exchange.`;
  return `Couldn't reach ${ex.name} (${(e && e.host) || 'network error'}). Check your internet connection, VPN or content blocker, or pick another exchange from the menu at the top.`;
}
onRouteChange = () => onSocketStatus();
function notice(msg) {
  const n = $('#notice'); n.textContent = msg || ''; n.hidden = !msg;
  if (msg) n.insertAdjacentHTML('beforeend', ' <a href="diag.html" style="color:inherit;font-weight:600">Run a connection test →</a>');
}

/* ---------- views ---------- */
function showView(v) {
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  $$('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  try { history.replaceState(null, '', '#' + v); } catch {}
  window.scrollTo({ top: 0 });
  if (v === 'analyze') requestAnimationFrame(fitRange);
  if (window.onViewShown) window.onViewShown(v);
}
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); showView(g.dataset.goto); } });
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showView(b.dataset.view); });

/* ================= MARKETS ================= */
function buildMarketRows() {
  const tb = $('#mktTable tbody');
  $('#mktQuote').textContent = EX().quote; $('#mktSource').textContent = EX().name;
  tb.innerHTML = EX().assets.map((s) => `
    <tr data-s="${s}">
      <td><div class="asset"><span class="ic">${s.slice(0, 3)}</span><div>${s}<br><small>${NAMES[s] || ''}</small></div></div></td>
      <td class="r" data-f="price">—</td>
      <td class="r" data-f="chg">—</td>
      <td class="r hide-sm" data-f="high">—</td>
      <td class="r hide-sm" data-f="low">—</td>
      <td class="hide-sm"><div class="range"><i data-f="rng"></i></div></td>
      <td class="r hide-sm" data-f="vol">—</td>
    </tr>`).join('');
}
$('#mktTable tbody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr'); if (!tr) return;
  selectSymbol(tr.dataset.s); showView('analyze');
});
function renderTicker(sym) {
  const t = state.tickers[sym]; const tr = $(`#mktTable tr[data-s="${sym}"]`); if (!t || !tr) return;
  const pc = tr.querySelector('[data-f=price]');
  if (t.prev != null && t.prev !== t.price) {
    pc.classList.remove('flash-up', 'flash-down'); void pc.offsetWidth;
    pc.classList.add(t.price > t.prev ? 'flash-up' : 'flash-down');
  }
  pc.textContent = fmtP(t.price);
  const c = tr.querySelector('[data-f=chg]'); c.innerHTML = `<span class="pill ${cls(t.chg)}">${fmtPct(t.chg)}</span>`;
  tr.querySelector('[data-f=high]').textContent = fmtP(t.high);
  tr.querySelector('[data-f=low]').textContent = fmtP(t.low);
  tr.querySelector('[data-f=vol]').textContent = fmtCompact(t.vol);
  const pos = t.high > t.low ? ((t.price - t.low) / (t.high - t.low)) * 100 : 50;
  tr.querySelector('[data-f=rng]').style.left = `calc(${pos}% - 1px)`;
}
let summaryQueued = false;
function renderMarketSummary() {
  summaryQueued = false;
  const list = EX().assets.map((s) => ({ s, ...state.tickers[s] })).filter((t) => t.price != null);
  if (!list.length) return;
  const sorted = [...list].sort((a, b) => b.chg - a.chg);
  const g = sorted[0], l = sorted.at(-1);
  $('#topGain').innerHTML = `${g.s} <span class="up">${fmtPct(g.chg)}</span>`;
  $('#topLose').innerHTML = `${l.s} <span class="down">${fmtPct(l.chg)}</span>`;
  const ups = list.filter((t) => t.chg > 0).length;
  $('#breadth').innerHTML = `<span class="up">${ups} up</span> · <span class="down">${list.length - ups} down</span>`;
}
function setTicker(sym, t) {
  if (!EX().assets.includes(sym) || !(t.price > 0)) return;
  const old = state.tickers[sym];
  state.tickers[sym] = { ...t, prev: old ? old.price : null };
  renderTicker(sym);
  if (!summaryQueued) { summaryQueued = true; setTimeout(renderMarketSummary, 1000); }
  if (sym === state.symbol) renderHeadPrice();
  if (paper.futs.length) checkFutures(sym, t.price);
  queuePaperRender();
}
let stopTickers = null, marketsToken = 0;
async function startMarkets() {
  const tok = ++marketsToken, ex = EX();
  if (stopTickers) { stopTickers(); stopTickers = null; }
  buildMarketRows(); notice('');
  const onT = (t) => { if (tok !== marketsToken) return; setTicker(t.asset, t); if (!$('#notice').hidden) notice(''); };
  stopTickers = ex.tickers(ex.assets, onT);
  try {
    const list = await ex.snapshot(ex.assets);
    if (tok === marketsToken) list.forEach(onT);
  } catch (e) {
    console.warn('ticker snapshot failed', e);
    // Only warn if the live stream hasn't delivered prices either.
    if (tok === marketsToken) setTimeout(() => { if (tok === marketsToken && !Object.keys(state.tickers).length) notice(explainError(ex, e)); }, 4000);
  }
}

/* ================= INDICATORS ================= */
function sma(v, n) { const o = Array(v.length).fill(null); let s = 0; for (let i = 0; i < v.length; i++) { s += v[i]; if (i >= n) s -= v[i - n]; if (i >= n - 1) o[i] = s / n; } return o; }
function ema(v, n) {
  const o = Array(v.length).fill(null); const k = 2 / (n + 1);
  const st = v.findIndex((x) => x != null); if (st < 0 || v.length - st < n) return o;
  let s = 0; for (let i = st; i < st + n; i++) s += v[i];
  let e = s / n; o[st + n - 1] = e;
  for (let i = st + n; i < v.length; i++) { e = v[i] * k + e * (1 - k); o[i] = e; }
  return o;
}
function rsi(c, n = 14) {
  const o = Array(c.length).fill(null); if (c.length <= n) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = c[i] - c[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= n; l /= n; o[n] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = n + 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
function macd(c) {
  const f = ema(c, 12), s = ema(c, 26);
  const m = c.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const sig = ema(m, 9);
  const h = m.map((x, i) => (x != null && sig[i] != null ? x - sig[i] : null));
  return { m, sig, h };
}
function bollinger(c, n = 20, k = 2) {
  const mid = sma(c, n), up = [], lo = [];
  for (let i = 0; i < c.length; i++) {
    if (mid[i] == null) { up.push(null); lo.push(null); continue; }
    let v = 0; for (let j = i - n + 1; j <= i; j++) v += (c[j] - mid[i]) ** 2;
    const sd = Math.sqrt(v / n); up.push(mid[i] + k * sd); lo.push(mid[i] - k * sd);
  }
  return { mid, up, lo };
}
function atr(cs, n = 14) {
  if (cs.length <= n) return null;
  const tr = cs.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - cs[i - 1].close), Math.abs(c.low - cs[i - 1].close))));
  let a = tr.slice(1, n + 1).reduce((x, y) => x + y, 0) / n;
  for (let i = n + 1; i < tr.length; i++) a = (a * (n - 1) + tr[i]) / n;
  return a;
}
function srLevels(cs, w = 5, look = 200) {
  const st = Math.max(w, cs.length - look), hi = [], lo = [];
  for (let i = st; i < cs.length - w; i++) {
    let isH = true, isL = true;
    for (let j = i - w; j <= i + w; j++) { if (cs[j].high > cs[i].high) isH = false; if (cs[j].low < cs[i].low) isL = false; }
    if (isH) hi.push(cs[i].high); if (isL) lo.push(cs[i].low);
  }
  const p = cs.at(-1).close;
  return { res: hi.filter((x) => x > p).sort((a, b) => a - b)[0] ?? null, sup: lo.filter((x) => x < p).sort((a, b) => b - a)[0] ?? null };
}
function computeAll(cs) {
  const c = cs.map((x) => x.close);
  return { sma20: sma(c, 20), ema50: ema(c, 50), rsi: rsi(c), macd: macd(c), bb: bollinger(c) };
}

/* ================= CHARTS ================= */
const charts = {};
function mkChart(el, showTime) {
  return LightweightCharts.createChart(el, {
    autoSize: true,
    layout: { background: { color: 'transparent' }, textColor: css('--muted'), fontFamily: 'Inter, sans-serif' },
    grid: { vertLines: { color: '#1a2131' }, horzLines: { color: '#1a2131' } },
    rightPriceScale: { borderColor: css('--border'), minimumWidth: 80 },
    timeScale: { borderColor: css('--border'), timeVisible: true, secondsVisible: false, visible: showTime },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
}
function initCharts() {
  const up = css('--up'), down = css('--down');
  const main = mkChart($('#chMain'), false), r = mkChart($('#chRsi'), false), m = mkChart($('#chMacd'), true);
  charts.main = main; charts.rsiC = r; charts.macdC = m;
  charts.candle = main.addCandlestickSeries({ upColor: up, downColor: down, borderVisible: false, wickUpColor: up, wickDownColor: down });
  charts.vol = main.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  charts.vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  const line = (color, extra = {}) => main.addLineSeries({ color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false, ...extra });
  charts.sma = line(css('--c-sma'));
  charts.ema = line(css('--c-ema'));
  const bbc = css('--c-bb');
  charts.bbU = line(bbc, { lineWidth: 1 }); charts.bbM = line(bbc, { lineWidth: 1, lineStyle: 2 }); charts.bbL = line(bbc, { lineWidth: 1 });
  charts.rsi = r.addLineSeries({ color: '#b388ff', lineWidth: 2, priceLineVisible: false });
  [70, 30].forEach((v) => charts.rsi.createPriceLine({ price: v, color: '#5a6478', lineStyle: 2, lineWidth: 1, axisLabelVisible: true }));
  charts.rsi.createPriceLine({ price: 50, color: '#2c3548', lineStyle: 3, lineWidth: 1, axisLabelVisible: false });
  charts.mHist = m.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
  charts.mLine = m.addLineSeries({ color: css('--accent'), lineWidth: 2, priceLineVisible: false });
  charts.mSig = m.addLineSeries({ color: css('--warn'), lineWidth: 1, priceLineVisible: false });
  charts.srLines = [];

  // keep the 3 panes scrolled/zoomed together
  const all = [main, r, m]; let syncing = false;
  all.forEach((c) => c.timeScale().subscribeVisibleLogicalRangeChange((range) => {
    if (syncing || !range) return; syncing = true;
    all.forEach((o) => o !== c && o.timeScale().setVisibleLogicalRange(range));
    syncing = false;
  }));
  applyToggles();
}
function applyToggles() {
  const sm = $('#tSma').checked, em = $('#tEma').checked, bb = $('#tBb').checked;
  charts.sma.applyOptions({ visible: sm }); charts.ema.applyOptions({ visible: em });
  [charts.bbU, charts.bbM, charts.bbL].forEach((s) => s.applyOptions({ visible: bb }));
  drawLevels();
}
['#tSma', '#tEma', '#tBb', '#tSr'].forEach((id) => $(id).addEventListener('change', applyToggles));

const pt = (cs, arr, i) => (arr[i] == null ? { time: cs[i].time } : { time: cs[i].time, value: arr[i] });
const ser = (cs, arr) => cs.map((_, i) => pt(cs, arr, i));
const volPt = (c) => ({ time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(22,199,132,.35)' : 'rgba(234,57,67,.35)' });
const histPt = (cs, h, i) => (h[i] == null ? { time: cs[i].time } : { time: cs[i].time, value: h[i], color: h[i] >= 0 ? (i > 0 && h[i] < h[i - 1] ? 'rgba(22,199,132,.45)' : '#16c784') : (i > 0 && h[i] > h[i - 1] ? 'rgba(234,57,67,.45)' : '#ea3943') });

function setAllData() {
  const cs = state.candles, I = computeAll(cs); state.ind = I;
  charts.candle.setData(cs);
  charts.vol.setData(cs.map(volPt));
  charts.sma.setData(ser(cs, I.sma20)); charts.ema.setData(ser(cs, I.ema50));
  charts.bbU.setData(ser(cs, I.bb.up)); charts.bbM.setData(ser(cs, I.bb.mid)); charts.bbL.setData(ser(cs, I.bb.lo));
  charts.rsi.setData(ser(cs, I.rsi));
  charts.mHist.setData(cs.map((_, i) => histPt(cs, I.macd.h, i)));
  charts.mLine.setData(ser(cs, I.macd.m)); charts.mSig.setData(ser(cs, I.macd.sig));
  charts.needsFit = true; fitRange();
}
function fitRange() {
  if (!charts.needsFit || !$('#chMain').clientWidth) return; // wait until the tab is visible
  charts.needsFit = false;
  requestAnimationFrame(() => { const n = state.candles.length; charts.main.timeScale().setVisibleLogicalRange({ from: n - 150, to: n + 4 }); });
}
function updateLast() {
  const cs = state.candles, I = computeAll(cs), i = cs.length - 1; state.ind = I;
  charts.candle.update(cs[i]); charts.vol.update(volPt(cs[i]));
  charts.sma.update(pt(cs, I.sma20, i)); charts.ema.update(pt(cs, I.ema50, i));
  charts.bbU.update(pt(cs, I.bb.up, i)); charts.bbM.update(pt(cs, I.bb.mid, i)); charts.bbL.update(pt(cs, I.bb.lo, i));
  charts.rsi.update(pt(cs, I.rsi, i));
  charts.mHist.update(histPt(cs, I.macd.h, i)); charts.mLine.update(pt(cs, I.macd.m, i)); charts.mSig.update(pt(cs, I.macd.sig, i));
}
function drawLevels() {
  if (!charts.candle) return;
  charts.srLines.forEach((l) => charts.candle.removePriceLine(l)); charts.srLines = [];
  if (!$('#tSr').checked || !state.levels) return;
  const { sup, res } = state.levels;
  if (res) charts.srLines.push(charts.candle.createPriceLine({ price: res, color: css('--down'), lineStyle: 2, lineWidth: 1, title: 'Resistance' }));
  if (sup) charts.srLines.push(charts.candle.createPriceLine({ price: sup, color: css('--up'), lineStyle: 2, lineWidth: 1, title: 'Support' }));
}

/* ================= ANALYZE: data ================= */
let chartStream = null, loadToken = 0, chartRetries = 0;
async function loadChart(isRetry) {
  if (!isRetry) chartRetries = 0;
  const tok = ++loadToken, sym = state.symbol, iv = state.interval, ex = EX();
  if (chartStream) { chartStream(); chartStream = null; }
  $('#book').innerHTML = '<div class="muted">Loading…</div>'; $('#trades').innerHTML = '';
  $('#chartErr').hidden = true;
  tradesBuf.length = 0; bookData = null;
  let last = null;
  try {
    const rows = await ex.klines(sym, iv); if (tok !== loadToken) return;
    state.candles = rows.map(toCandle);
    last = rows.at(-1);
  } catch (e) {
    console.warn('klines failed', e); if (tok !== loadToken) return;
    state.candles = [];
    const err = $('#chartErr'); err.hidden = false;
    err.textContent = `Couldn't load ${pair(sym)} candles from ${ex.name}: ${explainError(ex, e)}`;
    if (chartRetries++ < 3) { // temporary hiccups (rate limits, slow networks): try again shortly
      err.textContent += ' Retrying…';
      setTimeout(() => { if (tok === loadToken) loadChart(true); }, 4000 * chartRetries);
    }
  }
  setAllData(); analyze(true);
  const guard = (fn) => (x) => tok === loadToken && fn(x);
  chartStream = ex.chart(sym, iv, { kline: guard(onKline), trade: guard(onTrade), book: guard(onDepth) }, last);
}
const toCandle = (k) => ({ time: k.t / 1000 + TZ_SHIFT, open: k.o, high: k.h, low: k.l, close: k.c, volume: k.v });
function onKline(k) {
  const cs = state.candles; if (!cs.length) return;
  const c = toCandle(k);
  const last = cs.at(-1);
  if (c.time === last.time) cs[cs.length - 1] = c;
  else if (c.time > last.time) { cs.push(c); if (cs.length > 1000) cs.shift(); }
  else return;
  updateLast(); analyze();
}

/* order book + trades, rendered at most once per animation frame */
let bookData = null, bookQueued = false;
function onDepth(d) { bookData = d; if (!bookQueued) { bookQueued = true; requestAnimationFrame(renderBook); } }
function renderBook() {
  bookQueued = false; if (!bookData) return;
  const asks = bookData.asks.slice(0, 10).map(([p, q]) => [+p, +q]);
  const bids = bookData.bids.slice(0, 10).map(([p, q]) => [+p, +q]);
  const max = Math.max(...asks.map((a) => a[1]), ...bids.map((b) => b[1]));
  const row = ([p, q], color) => `<div class="brow"><div class="fill" style="width:${(q / max) * 100}%;background:${color}"></div><span class="${color === css('--up') ? 'up' : 'down'}">${fmtP(p)}</span><span>${fmtQty(q)}</span><span class="muted">${fmtCompact(p * q)}</span></div>`;
  const up = css('--up'), dn = css('--down');
  const bestA = asks[0]?.[0], bestB = bids[0]?.[0];
  const sumB = bids.reduce((s, b) => s + b[0] * b[1], 0), sumA = asks.reduce((s, a) => s + a[0] * a[1], 0);
  const imb = sumA + sumB ? (sumB / (sumA + sumB)) * 100 : 50;
  $('#book').innerHTML =
    `<div class="brow bhead"><span>Price</span><span>Size</span><span>Total</span></div>` +
    asks.slice().reverse().map((a) => row(a, dn)).join('') +
    `<div class="spread">${fmtP((bestA + bestB) / 2)} <span class="muted small">spread ${fmtP(bestA - bestB)}</span></div>` +
    bids.map((b) => row(b, up)).join('') +
    `<div class="small muted" style="margin-top:6px">Bid/ask depth: <span class="${imb >= 50 ? 'up' : 'down'}">${imb.toFixed(0)}% bids</span></div>`;
}
const tradesBuf = []; let tradesQueued = false;
function onTrade(d) {
  tradesBuf.unshift(d); if (tradesBuf.length > 18) tradesBuf.length = 18;
  if (!tradesQueued) { tradesQueued = true; requestAnimationFrame(() => {
    tradesQueued = false;
    $('#trades').innerHTML = `<div class="brow bhead"><span>Price</span><span>Size</span><span>Time</span></div>` +
      tradesBuf.map((t) => `<div class="brow"><span class="${t.sell ? 'down' : 'up'}">${fmtP(t.p)}</span><span>${fmtQty(t.q)}</span><span class="muted">${new Date(t.t).toLocaleTimeString()}</span></div>`).join('');
  }); }
}

/* ================= ANALYZE: signals ================= */
/* Score the latest candle with simple, explainable rules. Shared by Analyze and Signals. */
const verdictLabel = (norm) => (norm > 0.5 ? 'Strong bullish' : norm > 0.15 ? 'Leaning bullish' : norm < -0.5 ? 'Strong bearish' : norm < -0.15 ? 'Leaning bearish' : 'Neutral');
function evaluate(cs, I) {
  const i = cs.length - 1, p = cs[i].close, sigs = [];
  const add = (key, name, verdict, value, explain) => sigs.push({ key, name, verdict, value, explain });

  const s20 = I.sma20[i], e50 = I.ema50[i];
  if (s20 && e50) {
    const above = p > e50;
    add('trend', 'Trend (EMA 50)', above ? 'bull' : 'bear', above ? 'Price above' : 'Price below',
      above ? 'Price is above its 50-period EMA: the medium-term trend is up.' : 'Price is below its 50-period EMA: the medium-term trend is down.');
    const prevCross = I.sma20[i - 5] != null && I.ema50[i - 5] != null ? Math.sign(I.sma20[i - 5] - I.ema50[i - 5]) : 0;
    const nowCross = Math.sign(s20 - e50);
    const fresh = prevCross && prevCross !== nowCross;
    add('ma', 'MA crossover', nowCross > 0 ? 'bull' : 'bear', (nowCross > 0 ? 'SMA20 > EMA50' : 'SMA20 < EMA50') + (fresh ? ' · new' : ''),
      fresh ? 'The fast average just crossed the slow one, a classic early trend-change signal.' : 'Fast average relative to slow average shows short-term momentum direction.');
  }
  const r = I.rsi[i];
  if (r != null) {
    const v = r > 70 ? 'bear' : r < 30 ? 'bull' : r >= 50 ? 'bull' : 'bear';
    const label = r > 70 ? 'Overbought' : r < 30 ? 'Oversold' : r >= 50 ? 'Bullish momentum' : 'Bearish momentum';
    add('rsi', 'RSI (14)', r > 70 || r < 30 ? v : r > 55 ? 'bull' : r < 45 ? 'bear' : 'neutral', `${r.toFixed(1)} · ${label}`,
      r > 70 ? 'Buyers have pushed hard; a pullback becomes more likely (not guaranteed).' : r < 30 ? 'Sellers look exhausted; a bounce becomes more likely (not guaranteed).' : 'Between 30 and 70: no extreme. Above 50 favors buyers, below 50 favors sellers.');
  }
  const M = I.macd;
  if (M.m[i] != null && M.sig[i] != null) {
    const bull = M.m[i] > M.sig[i];
    const rising = M.h[i - 1] != null && M.h[i] > M.h[i - 1];
    add('macd', 'MACD', bull ? 'bull' : 'bear', `${bull ? 'Above' : 'Below'} signal · hist ${rising ? 'rising' : 'falling'}`,
      bull ? 'MACD line above its signal line means upside momentum is in control.' : 'MACD line below its signal line means downside momentum is in control.');
  }
  const B = I.bb;
  if (B.up[i] != null) {
    const pb = (p - B.lo[i]) / (B.up[i] - B.lo[i]);
    const bw = cs.map((_, j) => (B.up[j] != null ? (B.up[j] - B.lo[j]) / B.mid[j] : null)).filter((x) => x != null).slice(-120);
    const squeeze = bw.at(-1) <= Math.min(...bw) * 1.1;
    add('bb', 'Bollinger Bands', pb > 1 ? 'bear' : pb < 0 ? 'bull' : 'neutral', `%B ${(pb * 100).toFixed(0)}${squeeze ? ' · squeeze' : ''}`,
      squeeze ? 'Bands are unusually narrow (a "squeeze"); big moves often follow quiet periods.' : pb > 1 ? 'Price closed above the upper band: stretched to the upside.' : pb < 0 ? 'Price closed below the lower band: stretched to the downside.' : 'Price is inside the bands; %B shows where (0 = lower band, 100 = upper).');
  }
  const vAvg = cs.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  if (vAvg) {
    const ratio = cs[i].volume / vAvg, bullBar = cs[i].close >= cs[i].open;
    add('vol', 'Volume', ratio > 1.5 ? (bullBar ? 'bull' : 'bear') : 'neutral', `${ratio.toFixed(2)}× avg`,
      ratio > 1.5 ? 'Volume is well above average, so this candle carries more conviction.' : 'Volume is normal; the current move has no unusual participation yet.');
  }

  const score = sigs.reduce((s, x) => s + (x.verdict === 'bull' ? 1 : x.verdict === 'bear' ? -1 : 0), 0);
  const norm = sigs.length ? score / sigs.length : 0;
  return { sigs, score, norm, label: verdictLabel(norm) };
}

let lastAnalysis = 0;
function analyze(force) {
  const now = Date.now(); if (!force && now - lastAnalysis < 1000) return; lastAnalysis = now;
  const cs = state.candles, I = state.ind;
  if (!cs.length || !I) { state.levels = null; drawLevels(); $('#signals').innerHTML = ''; $('#levels').innerHTML = ''; $('#gaugeText').textContent = '—'; return; }
  const p = cs.at(-1).close, { sigs, norm, label } = evaluate(cs, I);
  $('#gaugeNeedle').style.left = `${50 + norm * 48}%`;
  $('#gaugeText').innerHTML = `<span class="${cls(norm)}">${label}</span>`;
  const tagTxt = { bull: 'Bullish', bear: 'Bearish', neutral: 'Neutral' };
  $('#signals').innerHTML = sigs.map((s) => `<li class="${state.highlight === s.key ? 'hl' : ''}"><div class="sig-top"><b>${s.name}</b><span class="tag ${s.verdict}">${tagTxt[s.verdict]}</span></div><div class="sig-top"><span class="mono small">${s.value}</span></div><div class="sig-ex">${s.explain}</div></li>`).join('');

  state.levels = srLevels(cs);
  const a = atr(cs);
  const { sup, res } = state.levels;
  $('#levels').innerHTML =
    `<span class="muted">Resistance</span><span class="down">${res ? fmtP(res) + ` (${fmtPct(((res - p) / p) * 100)})` : '—'}</span>` +
    `<span class="muted">Support</span><span class="up">${sup ? fmtP(sup) + ` (${fmtPct(((sup - p) / p) * 100)})` : '—'}</span>` +
    `<span class="muted">Volatility (ATR 14)</span><span>${a ? fmtP(a) + ` (${((a / p) * 100).toFixed(2)}%)` : '—'}</span>`;
  drawLevels();
  $('#aUpd').textContent = new Date().toLocaleTimeString();
  if (!state.tickers[state.symbol]) renderHeadPrice(p);
}
function renderHeadPrice(fallback) {
  const t = state.tickers[state.symbol];
  $('#aPrice').textContent = fmtP(t ? t.price : fallback);
  if (t) { const c = $('#aChg'); c.textContent = fmtPct(t.chg) + ' 24h'; c.className = 'pill ' + cls(t.chg); }
}

function selectSymbol(sym) {
  if (!EX().assets.includes(sym)) return;
  state.symbol = sym; $('#symSel').value = sym; renderHeadPrice(); loadChart();
}
function fillAssetSelects() {
  const opts = EX().assets.map((s) => `<option value="${s}">${pair(s)} · ${NAMES[s]}</option>`).join('');
  const keepP = $('#pSym').value;
  $('#symSel').innerHTML = opts; $('#pSym').innerHTML = opts;
  $('#symSel').value = state.symbol;
  if (EX().assets.includes(keepP)) $('#pSym').value = keepP;
  updateForms();
  $$('#intervalSeg button').forEach((b) => {
    const ok = EX().intervals[b.dataset.i] != null;
    b.disabled = !ok; b.title = ok ? '' : `${EX().name} has no ${b.dataset.i} candles`;
  });
}
function switchExchange(id) {
  if (!EXCHANGES[id] || id === state.ex) return;
  state.ex = id; state.tickers = {};
  try { localStorage.setItem(EX_KEY, id); } catch {}
  try { const u = new URL(location.href); u.searchParams.set('ex', id); history.replaceState(null, '', u); } catch {}
  $('#exSel').value = id;
  if (!EX().assets.includes(state.symbol)) state.symbol = 'BTC';
  if (EX().intervals[state.interval] == null) {
    state.interval = '1h';
    $$('#intervalSeg button').forEach((x) => x.classList.toggle('active', x.dataset.i === '1h'));
  }
  fillAssetSelects(); onSocketStatus(); renderHeadPrice();
  startMarkets(); loadChart(); renderPaper(); updateForms();
  if (window.onExchangeChanged) window.onExchangeChanged();
}
function initAnalyze() {
  fillAssetSelects();
  $('#symSel').addEventListener('change', (e) => selectSymbol(e.target.value));
  $('#intervalSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    $$('#intervalSeg button').forEach((x) => x.classList.toggle('active', x === b));
    state.interval = b.dataset.i; loadChart();
  });
  initCharts(); loadChart();
}

/* ================= PAPER TRADING ================= */
const PT_KEY = 'tradelens_paper_v1';
const SPOT_FEE = 0.001;      // 0.1% per spot trade
const FUT_FEE = 0.0005;      // 0.05% of notional per futures open/close
const MMR = 0.005;           // maintenance margin rate (isolated)
const START_CASH = 10000;
const freshPaper = () => ({ cash: START_CASH, pos: {}, futs: [], hist: [], realized: 0 });
let paper = (() => { try { return JSON.parse(localStorage.getItem(PT_KEY)) || freshPaper(); } catch { return freshPaper(); } })();
(() => { // migrate older saves ("BTCUSDT" keys, no futures)
  const pos = {};
  Object.entries(paper.pos || {}).forEach(([k, v]) => { pos[base(k)] = v; });
  paper.pos = pos; paper.futs = paper.futs || []; paper.realized = paper.realized || 0;
  paper.hist = (paper.hist || []).map((h) => ({ mkt: 'Spot', ...h, s: base(h.s) }));
})();
const savePaper = () => { try { localStorage.setItem(PT_KEY, JSON.stringify(paper)); } catch {} };
const livePrice = (s) => state.tickers[s]?.price;
const pt$ = { mode: 'spot', side: 'buy' };
function pMsg(t, ok) { const m = $('#pMsg'); m.textContent = t; m.className = 'msg ' + (ok ? 'up' : 'down'); }
function logTrade(e) { paper.hist.unshift({ t: Date.now(), ex: EX().name, ...e }); paper.hist = paper.hist.slice(0, 200); }
function afterTrade() { savePaper(); renderPaper(); renderHist(); updateForms(); }

/* ----- spot ----- */
function spotTrade() {
  const s = $('#pSym').value, p = livePrice(s), usd = +$('#pAmt').value;
  if (!p) return pMsg('Waiting for live price…');
  if (!(usd > 0)) return pMsg('Enter an amount above 0.');
  if (pt$.side === 'buy') {
    if (usd > paper.cash + 1e-9) return pMsg(`Not enough cash. Available: ${fmtUsd(paper.cash)}`);
    const qty = (usd * (1 - SPOT_FEE)) / p, pos = paper.pos[s] || { qty: 0, cost: 0 };
    pos.qty += qty; pos.cost += usd; paper.pos[s] = pos; paper.cash -= usd;
    logTrade({ mkt: 'Spot', side: 'BUY', s, qty, p, pnl: null });
    afterTrade(); pMsg(`Bought ${fmtQty(qty)} ${s} at ${fmtP(p)} (${EX().name})`, true);
  } else {
    const pos = paper.pos[s];
    if (!pos) return pMsg(`You don't hold any ${s}. To profit from a falling price, use Futures → Sell / Short.`);
    const holdVal = pos.qty * p;
    sellSpot(s, usd >= holdVal * 0.999 ? 1 : usd / holdVal);
  }
}
function sellSpot(s, frac) {
  const p = livePrice(s), pos = paper.pos[s];
  if (!pos) return; if (!p) return pMsg('Waiting for live price…');
  frac = Math.min(1, frac);
  const qty = pos.qty * frac, proceeds = qty * p * (1 - SPOT_FEE), costPart = pos.cost * frac, pnl = proceeds - costPart;
  pos.qty -= qty; pos.cost -= costPart; if (frac >= 1 || pos.qty < 1e-12) delete paper.pos[s];
  paper.cash += proceeds; paper.realized += pnl;
  logTrade({ mkt: 'Spot', side: 'SELL', s, qty, p, pnl });
  afterTrade(); pMsg(`Sold ${fmtQty(qty)} ${s} at ${fmtP(p)} · P&L ${fmtUsd(pnl)}`, pnl >= 0);
}

/* ----- futures (simulated isolated-margin perpetuals) ----- */
const liqPrice = (side, entry, lev) => (side === 'long' ? entry * (1 - 1 / lev + MMR) : entry * (1 + 1 / lev - MMR));
const futPnl = (f, mark) => (f.side === 'long' ? mark - f.entry : f.entry - mark) * f.qty;
function openFut(side) {
  const s = $('#pSym').value, p = livePrice(s), lev = +$('#pLev').value, margin = +$('#fMargin').value;
  const tp = +$('#fTp').value || null, sl = +$('#fSl').value || null;
  if (!p) return pMsg('Waiting for live price…');
  if (!(margin > 0)) return pMsg('Enter a margin above 0.');
  const notional = margin * lev, fee = notional * FUT_FEE;
  if (margin + fee > paper.cash + 1e-9) return pMsg(`Not enough cash. Margin + fee = ${fmtUsd(margin + fee)}, available ${fmtUsd(paper.cash)}`);
  const liq = liqPrice(side, p, lev);
  if (tp && (side === 'long' ? tp <= p : tp >= p)) return pMsg(`Take profit must be ${side === 'long' ? 'above' : 'below'} the current price for a ${side}.`);
  if (sl && (side === 'long' ? sl >= p : sl <= p)) return pMsg(`Stop loss must be ${side === 'long' ? 'below' : 'above'} the current price for a ${side}.`);
  if (sl && (side === 'long' ? sl <= liq : sl >= liq)) return pMsg(`Stop loss is beyond the liquidation price (${fmtP(liq)}); you'd be liquidated first.`);
  const qty = notional / p;
  paper.cash -= margin + fee;
  // merge into an existing position with the same asset, side and leverage
  const f = paper.futs.find((x) => x.s === s && x.side === side && x.lev === lev);
  if (f) {
    f.entry = (f.entry * f.qty + p * qty) / (f.qty + qty); f.qty += qty; f.margin += margin; f.openFee += fee;
    f.liq = liqPrice(side, f.entry, lev); if (tp) f.tp = tp; if (sl) f.sl = sl;
  } else {
    paper.futs.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), s, side, lev, qty, entry: p, margin, openFee: fee, liq, tp, sl, ex: EX().name });
  }
  logTrade({ mkt: 'Futures', side: side === 'long' ? `OPEN LONG ${lev}×` : `OPEN SHORT ${lev}×`, s, qty, p, pnl: -fee });
  paper.realized -= fee;
  afterTrade(); pMsg(`Opened ${side} ${fmtQty(qty)} ${s} at ${fmtP(p)} with ${lev}× leverage · liquidation ${fmtP(liq)}`, true);
}
function closeFut(id, frac, reason, atPrice) {
  const f = paper.futs.find((x) => x.id === id); if (!f) return;
  const mark = atPrice || livePrice(f.s); if (!mark) return pMsg('Waiting for live price…');
  frac = Math.min(1, frac);
  const qty = f.qty * frac, gross = futPnl(f, mark) * frac, fee = qty * mark * FUT_FEE, marginPart = f.margin * frac;
  paper.cash += Math.max(0, marginPart + gross - fee);
  const pnl = gross - fee; paper.realized += pnl;
  f.qty -= qty; f.margin -= marginPart; f.openFee *= 1 - frac;
  if (frac >= 1 || f.qty < 1e-12) paper.futs = paper.futs.filter((x) => x !== f);
  const label = reason || `CLOSE ${f.side.toUpperCase()}`;
  logTrade({ mkt: 'Futures', side: label, s: f.s, qty, p: mark, pnl });
  afterTrade(); pMsg(`${label}: ${fmtQty(qty)} ${f.s} at ${fmtP(mark)} · P&L ${fmtUsd(pnl)}`, pnl >= 0);
}
function checkFutures(s, mark) {
  for (const f of paper.futs.filter((x) => x.s === s)) {
    const long = f.side === 'long';
    if (long ? mark <= f.liq : mark >= f.liq) {
      paper.futs = paper.futs.filter((x) => x !== f); paper.realized -= f.margin;
      logTrade({ mkt: 'Futures', side: `LIQUIDATED ${f.side.toUpperCase()}`, s, qty: f.qty, p: mark, pnl: -f.margin });
      afterTrade(); pMsg(`Your ${s} ${f.side} was liquidated at ${fmtP(mark)}. Margin of ${fmtUsd(f.margin)} lost.`);
    } else if (f.tp && (long ? mark >= f.tp : mark <= f.tp)) closeFut(f.id, 1, 'TAKE PROFIT', mark);
    else if (f.sl && (long ? mark <= f.sl : mark >= f.sl)) closeFut(f.id, 1, 'STOP LOSS', mark);
  }
}

/* ----- rendering ----- */
// Rebuild a table only when its rows change, otherwise update cells in place (keeps buttons clickable).
function renderRows(tbody, rows, cols, empty) {
  const key = rows.map((r) => r.key).join('|');
  if (!rows.length) { tbody.dataset.key = ''; tbody.innerHTML = `<tr><td colspan="${cols}" class="muted">${empty}</td></tr>`; return; }
  if (tbody.dataset.key !== key) {
    tbody.dataset.key = key;
    tbody.innerHTML = rows.map((r) => `<tr>${r.cells.map((c) => `<td class="${c.c || ''}">${c.h}</td>`).join('')}</tr>`).join('');
    return;
  }
  rows.forEach((r, i) => r.cells.forEach((c, j) => {
    if (c.keep) return; const td = tbody.rows[i].cells[j];
    if (td.innerHTML !== c.h) td.innerHTML = c.h; if (td.className !== (c.c || '')) td.className = c.c || '';
  }));
}
let paperQueued = false;
function queuePaperRender() { if (!paperQueued) { paperQueued = true; setTimeout(() => { paperQueued = false; renderPaper(); updateForms(); }, 500); } }
function renderPaper() {
  let spotVal = 0, upnl = 0, futVal = 0;
  const spotRows = Object.entries(paper.pos).map(([s, ps]) => {
    const p = livePrice(s) || ps.cost / ps.qty, v = ps.qty * p, pl = v - ps.cost; spotVal += v; upnl += pl;
    return { key: s, cells: [{ h: `<b>${s}</b>` }, { h: fmtQty(ps.qty), c: 'r' }, { h: fmtP(ps.cost / ps.qty), c: 'r' }, { h: fmtP(p), c: 'r' }, { h: fmtUsd(v), c: 'r' },
      { h: `${fmtUsd(pl)}<br><span class="small">${fmtPct((pl / ps.cost) * 100)}</span>`, c: 'r ' + cls(pl) },
      { h: `<button class="mini sell" data-sellall="${s}">Sell all</button>`, c: 'r', keep: true }] };
  });
  renderRows($('#pPos tbody'), spotRows, 7, 'No spot holdings. Use Spot → Buy to start.');
  const futRows = paper.futs.map((f) => {
    const mark = livePrice(f.s) || f.entry, pl = futPnl(f, mark), roe = (pl / f.margin) * 100; upnl += pl; futVal += f.margin + pl;
    return { key: f.id, cells: [
      { h: `<b>${f.s}</b><br><span class="tag ${f.side === 'long' ? 'bull' : 'bear'}">${f.side === 'long' ? 'Long' : 'Short'} ${f.lev}×</span>` },
      { h: fmtQty(f.qty), c: 'r' }, { h: fmtP(f.entry), c: 'r' }, { h: fmtP(mark), c: 'r' }, { h: fmtP(f.liq), c: 'r warn' },
      { h: fmtUsd(f.margin), c: 'r' },
      { h: `${fmtUsd(pl)}<br><span class="small">${fmtPct(roe)}</span>`, c: 'r ' + cls(pl) },
      { h: `${f.tp ? fmtP(f.tp) : '—'}<br>${f.sl ? fmtP(f.sl) : '—'}`, c: 'r small' },
      { h: `<button class="mini" data-close="${f.id}" data-frac="0.5">50%</button> <button class="mini sell" data-close="${f.id}" data-frac="1">Close</button>`, c: 'r nowrap', keep: true }] };
  });
  renderRows($('#pFut tbody'), futRows, 9, 'No futures positions. Use Futures → Buy / Long or Sell / Short.');
  const eq = paper.cash + spotVal + futVal;
  $('#pEquity').innerHTML = `${fmtUsd(eq)} <span class="small ${cls(eq - START_CASH)}">${fmtPct(((eq - START_CASH) / START_CASH) * 100)}</span>`;
  $('#pCash').textContent = fmtUsd(paper.cash);
  $('#pUpnl').innerHTML = `<span class="${cls(upnl)}">${fmtUsd(upnl)}</span>`;
  $('#pRpnl').innerHTML = `<span class="${cls(paper.realized)}">${fmtUsd(paper.realized)}</span>`;
}
function renderHist() {
  $('#pHist tbody').innerHTML = paper.hist.slice(0, 50).map((h) => {
    const up = /BUY|LONG|PROFIT/.test(h.side) && !/CLOSE|LIQ/.test(h.side);
    return `<tr><td class="muted small">${new Date(h.t).toLocaleString()}</td><td><span class="pill">${h.mkt || 'Spot'}</span></td><td class="${up ? 'up' : 'down'}">${h.side}</td><td>${h.s}${h.ex ? ` <span class="muted small">${h.ex}</span>` : ''}</td><td class="r">${fmtQty(h.qty)}</td><td class="r">${fmtP(h.p)}</td><td class="r ${h.pnl == null ? '' : cls(h.pnl)}">${h.pnl == null ? '—' : fmtUsd(h.pnl)}</td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">No trades yet.</td></tr>';
}
function updateForms() {
  const s = $('#pSym').value, p = livePrice(s);
  $('#pPx').textContent = fmtP(p); $('#pExName').textContent = `${EX().name} · ${pair(s)}`;
  // spot
  const hold = paper.pos[s], amt = +$('#pAmt').value || 0;
  const buy = pt$.side === 'buy';
  $('#spotAvail').innerHTML = buy ? `Available: <b>${fmtUsd(paper.cash)}</b>`
    : `Holding: <b>${hold ? fmtQty(hold.qty) : 0} ${s}</b>${hold && p ? ` ≈ ${fmtUsd(hold.qty * p)}` : ''}`;
  $('#amtLabel').textContent = buy ? `Spend (${EX().quote})` : `Sell value (${EX().quote})`;
  $('#spotEst').textContent = p && amt > 0 ? (buy ? `≈ ${fmtQty((amt * (1 - SPOT_FEE)) / p)} ${s} · fee ${fmtUsd(amt * SPOT_FEE)}` : `≈ ${fmtQty(amt / p)} ${s} → you receive ≈ ${fmtUsd(amt * (1 - SPOT_FEE))}`) : '';
  const go = $('#spotGo'); go.textContent = `${buy ? 'Buy' : 'Sell'} ${s}`; go.className = 'btn ' + (buy ? 'buy' : 'sell');
  // futures
  const lev = +$('#pLev').value, m = +$('#fMargin').value || 0;
  $('#levVal').textContent = lev + '×';
  $$('#levQuick button').forEach((b) => b.classList.toggle('active', +b.dataset.lev === lev));
  $('#futAvail').innerHTML = `Available: <b>${fmtUsd(paper.cash)}</b>`;
  $('#futEst').innerHTML = p && m > 0
    ? `Position size <b>${fmtUsd(m * lev)}</b> (${fmtQty((m * lev) / p)} ${s}) · fee ${fmtUsd(m * lev * FUT_FEE)}<br>Liquidation: long <b class="down">${fmtP(liqPrice('long', p, lev))}</b> · short <b class="down">${fmtP(liqPrice('short', p, lev))}</b>`
    : '';
}
function setMode(m) {
  pt$.mode = m;
  $$('#mktSeg button').forEach((b) => b.classList.toggle('active', b.dataset.m === m));
  $('#spotForm').hidden = m !== 'spot'; $('#futForm').hidden = m !== 'fut';
  updateForms();
}
function setSide(sd) {
  pt$.side = sd;
  $$('#sideSeg button').forEach((b) => b.classList.toggle('active', b.dataset.side === sd));
  updateForms();
}
function initPaper() {
  $('#pSym').addEventListener('change', updateForms);
  $('#mktSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setMode(b.dataset.m); });
  $('#sideSeg').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSide(b.dataset.side); });
  $('#spotQuick').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return; const s = $('#pSym').value, p = livePrice(s), pct = +b.dataset.pct;
    const total = pt$.side === 'buy' ? paper.cash : (paper.pos[s] && p ? paper.pos[s].qty * p : 0);
    $('#pAmt').value = Math.floor(total * pct * 100) / 100; updateForms();
  });
  $('#futQuick').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const lev = +$('#pLev').value, maxMargin = paper.cash / (1 + lev * FUT_FEE); // leave room for the fee
    $('#fMargin').value = Math.floor(maxMargin * +b.dataset.pct * 100) / 100; updateForms();
  });
  $('#levQuick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { $('#pLev').value = b.dataset.lev; updateForms(); } });
  ['#pAmt', '#pLev', '#fMargin'].forEach((id) => $(id).addEventListener('input', updateForms));
  $('#spotGo').addEventListener('click', spotTrade);
  $('#goLong').addEventListener('click', () => openFut('long'));
  $('#goShort').addEventListener('click', () => openFut('short'));
  $('#pPos').addEventListener('click', (e) => { const b = e.target.closest('[data-sellall]'); if (b) sellSpot(b.dataset.sellall, 1); });
  $('#pFut').addEventListener('click', (e) => { const b = e.target.closest('[data-close]'); if (b) closeFut(b.dataset.close, +b.dataset.frac); });
  $('#pReset').addEventListener('click', () => { if (confirm('Reset paper account to $10,000? Positions and history will be cleared.')) { paper = freshPaper(); afterTrade(); pMsg('Account reset.', true); } });
  setMode('spot'); renderPaper(); renderHist();
}

/* ================= LEARN ================= */
const LESSONS = [
  { id: 'candles', lvl: 'Beginner', title: 'Reading candlesticks', live: null, body: `
    <p>Each candle summarises one time period (e.g. 1 hour): <b>open, high, low, close</b>.</p>
    <ul><li><span class="up">Green</span>: closed higher than it opened (buyers won the period).</li>
    <li><span class="down">Red</span>: closed lower than it opened (sellers won).</li>
    <li>The thin <b>wicks</b> show the extreme prices reached. Long wicks mean price was rejected at that level.</li></ul>
    <div class="tip">Switch the interval (1m → 1D) on the Analyze tab: the same market can look bullish on one timeframe and bearish on another.</div>` },
  { id: 'trend', lvl: 'Beginner', title: 'Trend & moving averages', live: 'trend', body: `
    <p>A <b>moving average</b> smooths price to show direction. SMA = simple average of the last N closes; EMA weights recent closes more, so it reacts faster.</p>
    <ul><li>Price above a rising EMA 50 → uptrend. Below a falling one → downtrend.</li>
    <li>When the fast SMA 20 crosses above the slow EMA 50 it's a "golden cross"-style signal; crossing below is the opposite.</li></ul>
    <div class="tip">Moving averages lag. They confirm trends; they don't predict them. In sideways markets they give many false crosses.</div>` },
  { id: 'rsi', lvl: 'Intermediate', title: 'RSI: momentum', live: 'rsi', body: `
    <p>The <b>Relative Strength Index</b> compares recent gains to recent losses on a 0–100 scale.</p>
    <ul><li>Above <b>70</b> = overbought, below <b>30</b> = oversold.</li>
    <li>Above 50 means gains dominate; below 50, losses dominate.</li>
    <li><b>Divergence</b>: price makes a new high but RSI makes a lower high. Momentum is fading.</li></ul>
    <div class="tip">In strong trends RSI can stay overbought for a long time. "Overbought" is not a sell signal on its own.</div>` },
  { id: 'macd', lvl: 'Intermediate', title: 'MACD: trend + momentum', live: 'macd', body: `
    <p><b>MACD</b> = EMA 12 − EMA 26. The <b>signal line</b> is a 9-period EMA of MACD, and the <b>histogram</b> is the gap between them.</p>
    <ul><li>MACD crossing above signal → bullish momentum; below → bearish.</li>
    <li>Shrinking histogram bars (lighter colour) warn that momentum is weakening before a cross happens.</li></ul>` },
  { id: 'bb', lvl: 'Intermediate', title: 'Bollinger Bands: volatility', live: 'bb', body: `
    <p>A 20-period SMA with bands 2 standard deviations above and below. About 95% of closes fall inside the bands.</p>
    <ul><li>Bands widen when volatility rises and narrow when it falls.</li>
    <li>A <b>squeeze</b> (very narrow bands) often comes before a big move, but doesn't tell you which direction.</li>
    <li><b>%B</b> shows where price sits: 0 = lower band, 100 = upper band.</li></ul>` },
  { id: 'sr', lvl: 'Intermediate', title: 'Support & resistance', live: 'sr', body: `
    <p><b>Support</b> is a price where buyers have previously stepped in; <b>resistance</b> is where sellers have. TradeLens finds them from recent swing lows and highs.</p>
    <ul><li>The more times a level is tested, the more traders watch it.</li>
    <li>When resistance breaks, it often becomes new support (and vice versa).</li></ul>
    <div class="tip">Common practice: place stop losses just beyond a support/resistance level, not exactly on it.</div>` },
  { id: 'book', lvl: 'Intermediate', title: 'Order book & tape', live: 'book', body: `
    <p>The <b>order book</b> lists resting limit orders: <span class="up">bids</span> (buyers) and <span class="down">asks</span> (sellers). The gap between the best bid and best ask is the <b>spread</b>.</p>
    <ul><li>Large resting orders can act as short-term support/resistance, but they can be cancelled at any time.</li>
    <li>The <b>trades tape</b> shows executed trades: green = buyer hit the ask, red = seller hit the bid.</li></ul>` },
  { id: 'risk', lvl: 'Essential', title: 'Risk management', live: null, body: `
    <p>Surviving matters more than any single trade. Professional rules of thumb:</p>
    <ul><li>Risk only <b>1–2%</b> of your account per trade.</li>
    <li>Decide your <b>stop loss before entering</b>, then size the position from it (use the calculator below).</li>
    <li>Look for <b>reward:risk ≥ 2:1</b>. Then you can be wrong more than half the time and still profit.</li>
    <li>Never add to a losing position to "average down" without a plan.</li></ul>
    <div class="tip">Practice every idea in Paper Trade first. Track whether your signals actually work before risking real money.</div>` },
];
const DONE_KEY = 'tradelens_lessons_v1';
let doneSet = (() => { try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY)) || []); } catch { return new Set(); } })();
function renderLessons() {
  $('#lessons').innerHTML = LESSONS.map((l, i) => `
    <details class="lesson ${doneSet.has(l.id) ? 'done' : ''}" data-id="${l.id}">
      <summary><span class="num">${doneSet.has(l.id) ? '✓' : i + 1}</span><span class="lt">${l.title}</span><span class="lvl">${l.lvl}</span></summary>
      <div class="lesson-body">${l.body}
        <div class="lesson-actions">${l.live ? `<button class="primary" data-live="${l.live}">See it live →</button>` : ''}<button data-done="${l.id}">${doneSet.has(l.id) ? 'Completed ✓' : 'Mark complete'}</button></div>
      </div>
    </details>`).join('');
  $('#learnBar').style.width = (doneSet.size / LESSONS.length) * 100 + '%';
}
function seeLive(key) {
  state.highlight = key === 'trend' ? 'trend' : key;
  if (key === 'trend') { $('#tSma').checked = true; $('#tEma').checked = true; }
  if (key === 'bb') $('#tBb').checked = true;
  if (key === 'sr') $('#tSr').checked = true;
  applyToggles(); showView('analyze'); analyze(true);
  const target = { rsi: '#chRsi', macd: '#chMacd', book: '#book' }[key];
  if (target) setTimeout(() => $(target).scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  setTimeout(() => { state.highlight = null; analyze(true); }, 6000);
}
const QUIZ = [
  { q: 'A green candle means…', o: ['Volume was high', 'Close was above the open', 'Price hit a new high'], a: 1, why: 'Colour only compares close to open within that period.' },
  { q: 'RSI reads 78. What does that tell you?', o: ['Sell immediately', 'Momentum is strongly up / stretched', 'The trend is down'], a: 1, why: 'Overbought shows strength and stretch, not a guaranteed reversal.' },
  { q: 'MACD crosses above its signal line. This suggests…', o: ['Bullish momentum', 'Bearish momentum', 'Volatility is falling'], a: 0, why: 'The faster MACD line overtaking its average signals improving momentum.' },
  { q: 'Very narrow Bollinger Bands usually mean…', o: ['Price will go up', 'Low volatility, and a big move may follow', 'The market is closed'], a: 1, why: 'A squeeze signals low volatility; direction is unknown.' },
  { q: '$10,000 account, 1% risk, entry $100, stop $95. Max position size?', o: ['$1,000', '$2,000', '$5,000'], a: 1, why: 'Risk $100 ÷ $5 per unit = 20 units × $100 = $2,000.' },
  { q: 'With 2:1 reward:risk, the break-even win rate is about…', o: ['33%', '50%', '67%'], a: 0, why: 'Win 2R one third of the time, lose 1R two thirds: 2/3 − 2/3 = 0.' },
];
const qAns = {};
function renderQuiz() {
  $('#quiz').innerHTML = QUIZ.map((x, i) => `<div class="q" data-q="${i}"><p>${i + 1}. ${x.q}</p><div class="opts">${x.o.map((o, j) => {
    const st = qAns[i] == null ? '' : j === x.a ? 'right' : j === qAns[i] ? 'wrong' : '';
    return `<button data-o="${j}" class="${st}" ${qAns[i] != null ? 'disabled' : ''}>${o}</button>`; }).join('')}</div>${qAns[i] != null ? `<div class="why">${x.why}</div>` : ''}</div>`).join('');
  const n = Object.keys(qAns).length, right = Object.entries(qAns).filter(([i, a]) => QUIZ[i].a === a).length;
  $('#qScore').textContent = n ? `${right} / ${n} correct` : '';
}
function calc() {
  const acc = +$('#cAcc').value, risk = +$('#cRisk').value / 100, en = +$('#cEntry').value, sl = +$('#cStop').value;
  if (!(acc > 0 && risk > 0 && en > 0 && sl > 0) || en === sl) { $('#cOut').textContent = 'Enter valid numbers (entry and stop must differ).'; return; }
  const riskUsd = acc * risk, perUnit = Math.abs(en - sl), units = riskUsd / perUnit, size = units * en;
  const dir = sl < en ? 'long' : 'short', t2 = dir === 'long' ? en + 2 * perUnit : en - 2 * perUnit;
  $('#cOut').innerHTML = `Max loss if stopped: <b>${fmtUsd(riskUsd)}</b><br>Position: <b>${fmtQty(units)}</b> units = <b>${fmtUsd(size)}</b> (${((size / acc) * 100).toFixed(1)}% of account)<br>2:1 target (${dir}): <b>${fmtP(t2)}</b>${size > acc ? '<br><span class="down">Position exceeds account; that would need leverage.</span>' : ''}`;
}
function initLearn() {
  renderLessons(); renderQuiz(); calc();
  $('#lessons').addEventListener('click', (e) => {
    const live = e.target.closest('[data-live]'); if (live) return seeLive(live.dataset.live);
    const d = e.target.closest('[data-done]');
    if (d) { const id = d.dataset.done; const open = $$('#lessons details[open]').map((x) => x.dataset.id);
      doneSet.has(id) ? doneSet.delete(id) : doneSet.add(id);
      try { localStorage.setItem(DONE_KEY, JSON.stringify([...doneSet])); } catch {}
      renderLessons(); open.forEach((o) => { const el = $(`#lessons details[data-id="${o}"]`); if (el) el.open = true; }); }
  });
  $('#quiz').addEventListener('click', (e) => { const b = e.target.closest('[data-o]'); if (!b) return; qAns[b.closest('.q').dataset.q] = +b.dataset.o; renderQuiz(); });
  ['#cAcc', '#cRisk', '#cEntry', '#cStop'].forEach((id) => $(id).addEventListener('input', calc));
}

/* ================= boot ================= */
$('#exSel').innerHTML = Object.values(EXCHANGES).map((x) => `<option value="${x.id}">${x.name}</option>`).join('');
$('#exSel').value = state.ex;
$('#exSel').addEventListener('change', (e) => switchExchange(e.target.value));
startMarkets();
initAnalyze();
initPaper();
initLearn();
const startView = location.hash.slice(1);
if (['markets', 'analyze', 'signals', 'paper', 'learn'].includes(startView)) setTimeout(() => showView(startView), 0); // after signals.js loads
