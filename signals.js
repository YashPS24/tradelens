/* TradeLens Signals: scans every coin on the selected exchange across several timeframes,
 * scores each with the same rules as the Analyze tab, and lists fresh crossover/breakout events
 * together with how often that event has worked on that coin and timeframe in the past. */
'use strict';

const SG_TFS = ['15m', '1h', '4h', '1d'];
const SG_TF_LABEL = { '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1D' };
const SG_FORWARD = 5;           // candles ahead used to judge whether a past signal "worked"
const SG_REFRESH_MS = 120000;   // auto-refresh interval while the tab is open

// Discrete events we look for. dir: +1 bullish, -1 bearish.
const SG_EVENTS = [
  { key: 'macdUp', dir: 1, name: 'MACD crossed above its signal line', test: (I, cs, i) => cross(I.macd.m, I.macd.sig, i) > 0 },
  { key: 'macdDown', dir: -1, name: 'MACD crossed below its signal line', test: (I, cs, i) => cross(I.macd.m, I.macd.sig, i) < 0 },
  { key: 'maUp', dir: 1, name: 'SMA 20 crossed above EMA 50', test: (I, cs, i) => cross(I.sma20, I.ema50, i) > 0 },
  { key: 'maDown', dir: -1, name: 'SMA 20 crossed below EMA 50', test: (I, cs, i) => cross(I.sma20, I.ema50, i) < 0 },
  { key: 'rsiUp', dir: 1, name: 'RSI climbed back above 30 (leaving oversold)', test: (I, cs, i) => I.rsi[i - 1] != null && I.rsi[i - 1] < 30 && I.rsi[i] >= 30 },
  { key: 'rsiDown', dir: -1, name: 'RSI fell back below 70 (leaving overbought)', test: (I, cs, i) => I.rsi[i - 1] != null && I.rsi[i - 1] > 70 && I.rsi[i] <= 70 },
  { key: 'bbUp', dir: 1, name: 'Closed above the upper Bollinger Band', test: (I, cs, i) => I.bb.up[i - 1] != null && cs[i - 1].close <= I.bb.up[i - 1] && cs[i].close > I.bb.up[i] },
  { key: 'bbDown', dir: -1, name: 'Closed below the lower Bollinger Band', test: (I, cs, i) => I.bb.lo[i - 1] != null && cs[i - 1].close >= I.bb.lo[i - 1] && cs[i].close < I.bb.lo[i] },
  { key: 'volUp', dir: 1, name: 'Volume spike (2×+) on a green candle', test: (I, cs, i) => volSpike(cs, i) && cs[i].close > cs[i].open },
  { key: 'volDown', dir: -1, name: 'Volume spike (2×+) on a red candle', test: (I, cs, i) => volSpike(cs, i) && cs[i].close < cs[i].open },
];
function cross(a, b, i) {
  if (i < 1 || a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) return 0;
  if (a[i - 1] <= b[i - 1] && a[i] > b[i]) return 1;
  if (a[i - 1] >= b[i - 1] && a[i] < b[i]) return -1;
  return 0;
}
function volSpike(cs, i) {
  if (i < 21) return false;
  let s = 0; for (let j = i - 20; j < i; j++) s += cs[j].volume;
  return s > 0 && cs[i].volume > (2 * s) / 20;
}
// How did this event do historically on this series? (closed candles only)
function backtest(ev, I, cs) {
  let n = 0, wins = 0, move = 0;
  for (let i = 60; i < cs.length - 1 - SG_FORWARD; i++) {
    if (!ev.test(I, cs, i)) continue;
    const r = ((cs[i + SG_FORWARD].close - cs[i].close) / cs[i].close) * ev.dir;
    n++; move += r; if (r > 0) wins++;
  }
  return { n, wins, rate: n ? wins / n : null, avg: n ? (move / n) * 100 : null };
}

const sg = { results: {}, events: [], scanning: false, last: 0, exId: null, token: 0, filter: 'all', progress: 0 };
const sgVisible = () => $('#view-signals').classList.contains('active');

function analyzeSeries(a, tf, rows) {
  const cs = rows.map(toCandle);
  if (cs.length < 60) return { err: 'Not enough history' };
  const I = computeAll(cs), ev = evaluate(cs, I), n = cs.length;
  const events = [];
  for (const e of SG_EVENTS) {
    for (let i = n - 3; i < n; i++) {
      if (!e.test(I, cs, i)) continue;
      events.push({ a, tf, ev: e, ago: n - 1 - i, forming: i === n - 1, price: cs[i].close, time: cs[i].time - TZ_SHIFT, stats: backtest(e, I, cs) });
    }
  }
  const rsiNow = I.rsi[n - 1];
  return { norm: ev.norm, score: ev.score, count: ev.sigs.length, label: ev.label, rsi: rsiNow, events };
}

async function pool(jobs, n, gap, tok) {
  let k = 0;
  const worker = async () => {
    while (k < jobs.length && tok === sg.token) {
      const job = jobs[k++]; await job();
      if (gap) await new Promise((r) => setTimeout(r, gap));
    }
  };
  await Promise.all(Array.from({ length: n }, worker));
}

async function sgScan() {
  if (sg.scanning) return;
  const ex = EX(), tok = ++sg.token;
  sg.scanning = true; sg.exId = ex.id;
  const fresh = {}, events = [];
  const jobs = [];
  let done = 0;
  for (const a of ex.assets) {
    fresh[a] = sg.results[a] && sg.exId === ex.id ? { ...sg.results[a] } : {};
    for (const tf of SG_TFS) {
      jobs.push(async () => {
        if (ex.intervals[tf] == null) fresh[a][tf] = { na: true };
        else {
          try { const r = analyzeSeries(a, tf, await ex.klines(a, tf)); fresh[a][tf] = r; if (r.events) events.push(...r.events); }
          catch (e) { fresh[a][tf] = { err: e.message || 'Failed' }; }
        }
        done++; sg.progress = done / jobs.length;
        if (tok === sg.token) { sg.results = { ...sg.results, [a]: fresh[a] }; sgQueueRender(); }
      });
    }
  }
  // Be gentle with stricter rate limits.
  const conc = { kraken: 1, okx: 2, coinbase: 3 }[ex.id] || 4, gap = { kraken: 1100, okx: 200 }[ex.id] || 0;
  sgRenderStatus();
  await pool(jobs, conc, gap, tok);
  if (tok !== sg.token) return; // a newer scan (e.g. after switching exchange) took over
  sg.events = events; sg.last = Date.now(); sg.results = fresh;
  sg.scanning = false; sgRenderStatus(); sgRender();
}

/* ---------- rendering ---------- */
function sgBadge(r) {
  if (!r) return '<span class="sgb wait">…</span>';
  if (r.na) return '<span class="sgb na" title="This exchange has no candles for this timeframe">n/a</span>';
  if (r.err) return `<span class="sgb na" title="${r.err.replace(/"/g, '')}">error</span>`;
  const k = r.norm > 0.5 ? 'sb' : r.norm > 0.15 ? 'b' : r.norm < -0.5 ? 'ss' : r.norm < -0.15 ? 's' : 'n';
  const txt = { sb: 'Strong bull', b: 'Bullish', n: 'Neutral', s: 'Bearish', ss: 'Strong bear' }[k];
  return `<span class="sgb ${k}" title="${r.label}: ${r.score > 0 ? '+' : ''}${r.score} of ${r.count} rules · RSI ${r.rsi != null ? r.rsi.toFixed(0) : '—'}">${txt}<small>${r.score > 0 ? '+' : ''}${r.score}</small></span>`;
}
function sgAgreement(res) {
  const vals = SG_TFS.map((tf) => res && res[tf]).filter((r) => r && r.norm != null);
  if (!vals.length) return { h: '<span class="muted">—</span>', dir: 0 };
  const bull = vals.filter((r) => r.norm > 0.15).length, bear = vals.filter((r) => r.norm < -0.15).length;
  const dir = bull > bear ? 1 : bear > bull ? -1 : 0;
  const pct = Math.max(bull, bear) / vals.length;
  const word = dir > 0 ? 'bullish' : dir < 0 ? 'bearish' : 'mixed';
  return { h: dir ? `<span class="${dir > 0 ? 'up' : 'down'}"><b>${Math.max(bull, bear)}/${vals.length}</b> ${word}</span><div class="agree"><i class="${dir > 0 ? 'bu' : 'be'}" style="width:${pct * 100}%"></i></div>` : '<span class="muted">mixed</span>', dir };
}
let sgRenderQueued = false;
function sgQueueRender() { if (!sgRenderQueued) { sgRenderQueued = true; setTimeout(() => { sgRenderQueued = false; sgRender(); }, 300); } }
function sgRender() {
  if (!$('#sgTable')) return;
  const ex = EX();
  $('#sgEx').textContent = ex.name;
  const rows = [];
  for (const a of ex.assets) {
    const res = sg.exId === ex.id ? sg.results[a] : null, t = state.tickers[a], ag = sgAgreement(res);
    if (sg.filter === 'bull' && ag.dir <= 0) continue;
    if (sg.filter === 'bear' && ag.dir >= 0) continue;
    rows.push({ key: a, cells: [
      { h: `<b>${a}</b><br><span class="muted small">${NAMES[a] || ''}</span>` },
      { h: t ? fmtP(t.price) : '—', c: 'r mono hide-sm' },
      { h: t ? `<span class="${cls(t.chg)}">${fmtPct(t.chg)}</span>` : '—', c: 'r mono' },
      ...SG_TFS.map((tf) => ({ h: sgBadge(res && res[tf]), c: 'sgc' })),
      { h: ag.h },
    ] });
  }
  renderRows($('#sgTable tbody'), rows, 8, sg.filter === 'all' ? 'Scanning…' : `No coins where most timeframes are ${sg.filter === 'bull' ? 'bullish' : 'bearish'} right now.`);
  sgRenderFeed(); sgRenderStatus();
}
function sgRenderFeed() {
  const list = sg.exId === EX().id ? sg.events.slice() : [];
  const want = sg.filter === 'bull' ? 1 : sg.filter === 'bear' ? -1 : 0;
  const ev = list.filter((e) => !want || e.ev.dir === want)
    .sort((x, y) => x.ago - y.ago || (y.stats.rate ?? 0) - (x.stats.rate ?? 0) || SG_TFS.indexOf(y.tf) - SG_TFS.indexOf(x.tf));
  if (!ev.length) {
    $('#sgFeed').innerHTML = `<p class="muted small">${sg.scanning && !sg.last ? 'Scanning…' : 'No fresh crossover, breakout or volume events in the last 3 candles.'}</p>`;
    return;
  }
  $('#sgFeed').innerHTML = ev.slice(0, 40).map((e) => {
    const s = e.stats, up = e.ev.dir > 0;
    const hist = s.n >= 5
      ? `Past ${s.n} times on ${e.a} ${SG_TF_LABEL[e.tf]}: price moved ${up ? 'up' : 'down'} ${SG_FORWARD} candles later in <b class="${s.rate >= 0.55 ? 'up' : s.rate < 0.45 ? 'down' : ''}">${Math.round(s.rate * 100)}%</b> of cases (avg ${s.avg >= 0 ? '+' : ''}${s.avg.toFixed(2)}% in the signal's direction).`
      : `Too few past cases (${s.n}) on ${e.a} ${SG_TF_LABEL[e.tf]} to judge reliability.`;
    const when = e.forming ? '<span class="warn">current candle, may still change</span>' : e.ago === 1 ? '1 candle ago' : `${e.ago} candles ago`;
    return `<div class="sgev" data-a="${e.a}" data-tf="${e.tf}" tabindex="0">
      <div class="sgev-top"><span class="tf">${SG_TF_LABEL[e.tf]}</span><b>${e.a}</b><span class="tag ${up ? 'bull' : 'bear'}">${up ? 'Bullish' : 'Bearish'}</span><span class="muted small">${when}</span></div>
      <div>${e.ev.name} at <span class="mono">${fmtP(e.price)}</span></div>
      <div class="muted small">${hist}</div>
    </div>`;
  }).join('');
}
function sgRenderStatus() {
  const bar = $('#sgBar'); if (!bar) return;
  bar.style.width = (sg.scanning ? sg.progress * 100 : sg.last ? 100 : 0) + '%';
  $('#sgStatus').textContent = sg.scanning ? `Scanning ${EX().name}… ${Math.round(sg.progress * 100)}%` : sg.last ? `Updated ${new Date(sg.last).toLocaleTimeString()}` : '';
  $('#sgScan').disabled = sg.scanning;
}
function sgOpen(a, tf) {
  if (EX().intervals[tf] == null) return;
  state.interval = tf;
  $$('#intervalSeg button').forEach((x) => x.classList.toggle('active', x.dataset.i === tf));
  if (state.symbol === a) loadChart(); else selectSymbol(a);
  showView('analyze');
}

/* ---------- wiring ---------- */
window.onViewShown = (v) => {
  if (v !== 'signals') return;
  sgRender(); sgRenderStatus();
  if (!sg.scanning && (sg.exId !== EX().id || Date.now() - sg.last > SG_REFRESH_MS)) sgScan();
};
window.onExchangeChanged = () => {
  sg.token++; sg.scanning = false; sg.results = {}; sg.events = []; sg.last = 0; sg.exId = null; sg.progress = 0;
  sgRender(); sgRenderStatus();
  if (sgVisible()) sgScan();
};
$('#sgScan').addEventListener('click', () => sgScan());
$('#sgFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  sg.filter = b.dataset.f; $$('#sgFilter button').forEach((x) => x.classList.toggle('active', x === b)); sgRender();
});
$('#sgTable tbody').addEventListener('click', (e) => {
  const td = e.target.closest('td'); if (!td) return;
  const tr = td.parentElement, a = tr.querySelector('b') && tr.querySelector('b').textContent;
  const tfIdx = td.cellIndex - 3;
  if (a) sgOpen(a, SG_TFS[tfIdx] || state.interval);
});
$('#sgFeed').addEventListener('click', (e) => { const d = e.target.closest('.sgev'); if (d) sgOpen(d.dataset.a, d.dataset.tf); });
$('#sgFeed').addEventListener('keydown', (e) => { const d = e.target.closest('.sgev'); if (d && e.key === 'Enter') sgOpen(d.dataset.a, d.dataset.tf); });
setInterval(() => {
  if (!sgVisible()) return;
  sgRender(); // live prices
  if ($('#sgAuto').checked && !sg.scanning && Date.now() - sg.last > SG_REFRESH_MS) sgScan();
}, 3000);
