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
function backtest(ev, I, cs, reg) {
  let n = 0, wins = 0, move = 0;
  for (let i = 60; i < cs.length - 1 - SG_FORWARD; i++) {
    if (!ev.test(I, cs, i)) continue;
    if (reg && reg.dir[i] !== ev.dir) continue; // with-trend occurrences only
    const r = ((cs[i + SG_FORWARD].close - cs[i].close) / cs[i].close) * ev.dir;
    n++; move += r; if (r > 0) wins++;
  }
  return { n, wins, rate: n ? wins / n : null, avg: n ? (move / n) * 100 : null };
}

/* ---------- trade setup: entry, stop loss, take profits, leverage ----------
 * Stop loss: just beyond the nearest support (long) / resistance (short), kept between 1 and 3 ATR away;
 *   1.5 ATR if there is no level. Take profits at 1.5R and 3R (R = entry-to-stop distance).
 * Leverage: highest whole number that keeps the (isolated) liquidation price at least twice as far as the
 *   stop loss, capped at 10x. Above "max", liquidation would hit before the stop loss. */
const SG_MMR = 0.005;
function tradeSetup(cs, dir) {
  if (!dir) return null;
  const n = cs.length, entry = cs[n - 1].close, a = atr(cs);
  if (!a) return null;
  const { sup, res } = srLevels(cs);
  let sl;
  if (dir > 0) { sl = sup != null ? sup - 0.25 * a : entry - 1.5 * a; sl = Math.min(entry - a, Math.max(entry - 3 * a, sl)); }
  else { sl = res != null ? res + 0.25 * a : entry + 1.5 * a; sl = Math.max(entry + a, Math.min(entry + 3 * a, sl)); }
  const R = Math.abs(entry - sl), dist = R / entry;
  const levSafe = Math.max(1, Math.min(10, Math.floor(1 / (2 * dist + SG_MMR))));
  const levMax = Math.max(1, Math.floor(1 / (dist + SG_MMR)));
  const liq = dir > 0 ? entry * (1 - 1 / levSafe + SG_MMR) : entry * (1 + 1 / levSafe - SG_MMR);
  const tp1 = entry + dir * 1.5 * R, tp2 = entry + dir * 3 * R;
  const wall = dir > 0 ? res : sup; // first level price must get through
  const wallBeforeTp1 = wall != null && (dir > 0 ? wall < tp1 : wall > tp1);
  return { dir, entry, sl, tp1, tp2, R, dist, levSafe, levMax, liq, wall, wallBeforeTp1, atr: a };
}

/* ---------- market regime (trend filter) ----------
 * Uptrend: close above EMA 200, EMA 50 above EMA 200 and rising over 10 candles. Downtrend: the mirror.
 * The trend only counts when ADX(14) >= 20 (a trend with some strength); otherwise it's a range.
 * Backtests showed signals taken WITH this trend did much better than unfiltered or against-trend signals. */
const SG_ADX_MIN = 20;
function adxSeries(cs, n = 14) {
  const L = cs.length, adx = Array(L).fill(null);
  let sT = 0, sP = 0, sN = 0, a = null, cnt = 0, sum = 0;
  for (let i = 1; i < L; i++) {
    const h = cs[i].high, l = cs[i].low, pc = cs[i - 1].close, up = h - cs[i - 1].high, dn = cs[i - 1].low - l;
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0, tr = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
    if (i <= n) { sT += tr; sP += p; sN += m; if (i < n) continue; } else { sT += tr - sT / n; sP += p - sP / n; sN += m - sN / n; }
    const pd = (100 * sP) / sT, nd = (100 * sN) / sT, dx = (100 * Math.abs(pd - nd)) / (pd + nd || 1);
    if (a == null) { sum += dx; if (++cnt === n) a = sum / n; } else a = (a * (n - 1) + dx) / n;
    adx[i] = a;
  }
  return adx;
}
function regimeSeries(cs) {
  const c = cs.map((x) => x.close), e50 = ema(c, 50), e200 = ema(c, 200), adx = adxSeries(cs);
  const raw = cs.map((x, i) => {
    if (e200[i] == null || e50[i - 10] == null) return null;
    if (x.close > e200[i] && e50[i] > e200[i] && e50[i] > e50[i - 10]) return 1;
    if (x.close < e200[i] && e50[i] < e200[i] && e50[i] < e50[i - 10]) return -1;
    return 0;
  });
  const dir = raw.map((r, i) => (r == null ? null : r && adx[i] >= SG_ADX_MIN ? r : 0));
  return { dir, raw, adx };
}
function trendNow(cs) {
  if (cs.length < 215) return null;
  const R = regimeSeries(cs), i = cs.length - 1, dir = R.dir[i], raw = R.raw[i], adx = R.adx[i];
  if (dir == null) return null;
  const label = dir > 0 ? 'Uptrend' : dir < 0 ? 'Downtrend' : raw > 0 ? 'Weak uptrend' : raw < 0 ? 'Weak downtrend' : 'Range';
  return { dir, raw, adx, label };
}
window.trendNow = trendNow;

// Replay every past signal on this series as a trade: did TP1 or the stop loss come first? (fees included)
const SG_HOLD = 50, SG_FEE = 0.0005;
function simulateSetup(cs, i, dir) {
  const st = tradeSetup(cs.slice(0, i + 1), dir); if (!st) return null;
  let R = null;
  for (let j = i + 1; j < Math.min(cs.length, i + 1 + SG_HOLD); j++) {
    const c = cs[j];
    if (dir > 0 ? c.low <= st.sl : c.high >= st.sl) { R = -1; break; } // both in one candle: assume the stop came first
    if (dir > 0 ? c.high >= st.tp1 : c.low <= st.tp1) { R = 1.5; break; }
  }
  if (R == null) R = ((cs[Math.min(cs.length - 1, i + SG_HOLD)].close - st.entry) * dir) / st.R;
  return { win: R > 0, net: R - (2 * SG_FEE) / st.dist };
}
const accBucket = () => ({ n: 0, w: 0, net: 0, early: { n: 0, w: 0, net: 0 }, late: { n: 0, w: 0, net: 0 } });
function accAdd(b, r, late) { for (const o of [b, late ? b.late : b.early]) { o.n++; if (r.win) o.w++; o.net += r.net; } }
function accMerge(into, from) { for (const k of ['with', 'against', 'all']) for (const p of [null, 'early', 'late']) { const A = p ? into[k][p] : into[k], B = p ? from[k][p] : from[k]; A.n += B.n; A.w += B.w; A.net += B.net; } }
function setupBacktest(cs, I, reg) {
  const acc = { with: accBucket(), against: accBucket(), all: accBucket() }, start = 215, mid = (start + cs.length) / 2;
  for (let i = start; i < cs.length - 2; i++) {
    for (const e of SG_EVENTS) {
      if (!e.test(I, cs, i)) continue;
      const r = simulateSetup(cs, i, e.dir); if (!r) continue;
      const late = i >= mid;
      accAdd(acc.all, r, late);
      if (reg.dir[i] === e.dir) accAdd(acc.with, r, late); else if (reg.dir[i] === -e.dir) accAdd(acc.against, r, late);
    }
  }
  return acc;
}

const sg = { results: {}, events: [], scanning: false, last: 0, exId: null, token: 0, filter: 'all', progress: 0, acc: null, withOnly: true };
const sgVisible = () => $('#view-signals').classList.contains('active');

function analyzeSeries(a, tf, rows) {
  const cs = rows.map(toCandle);
  if (cs.length < 60) return { err: 'Not enough history' };
  const I = computeAll(cs), ev = evaluate(cs, I), n = cs.length;
  const reg = cs.length >= 215 ? regimeSeries(cs) : null, trend = trendNow(cs);
  const setups = { 1: tradeSetup(cs, 1), '-1': tradeSetup(cs, -1) };
  const cellDir = ev.norm > 0.15 ? 1 : ev.norm < -0.15 ? -1 : 0;
  // Only give a setup when the signal agrees with a confirmed trend.
  const block = !cellDir ? 'neutral' : !trend ? 'nohistory' : trend.dir === 0 ? 'range' : trend.dir !== cellDir ? 'against' : null;
  const events = [];
  for (const e of SG_EVENTS) {
    for (let i = n - 3; i < n; i++) {
      if (!e.test(I, cs, i)) continue;
      const tdir = reg ? reg.dir[i] : null, withTrend = tdir === e.dir;
      events.push({ a, tf, ev: e, ago: n - 1 - i, forming: i === n - 1, price: cs[i].close, time: cs[i].time - TZ_SHIFT,
        stats: backtest(e, I, cs), statsWith: reg ? backtest(e, I, cs, reg) : null,
        trend: tdir, withTrend, setup: withTrend ? setups[e.dir] : null });
    }
  }
  const rsiNow = I.rsi[n - 1];
  return { norm: ev.norm, score: ev.score, count: ev.sigs.length, label: ev.label, rsi: rsiNow, events, dir: cellDir, trend, block,
    setup: block ? null : setups[cellDir], acc: reg ? setupBacktest(cs, I, reg) : null };
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
  const fresh = {}, events = [], acc = { with: accBucket(), against: accBucket(), all: accBucket() };
  let accSeries = 0;
  const jobs = [];
  let done = 0;
  for (const a of ex.assets) {
    fresh[a] = sg.results[a] && sg.exId === ex.id ? { ...sg.results[a] } : {};
    for (const tf of SG_TFS) {
      jobs.push(async () => {
        if (ex.intervals[tf] == null) fresh[a][tf] = { na: true };
        else {
          try { const r = analyzeSeries(a, tf, await ex.klines(a, tf)); fresh[a][tf] = r; if (r.events) events.push(...r.events); if (r.acc) { accMerge(acc, r.acc); accSeries++; } }
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
  sg.events = events; sg.last = Date.now(); sg.results = fresh; sg.acc = { ...acc, series: accSeries, ex: ex.name };
  sg.scanning = false; sgRenderStatus(); sgRender();
}

/* ---------- rendering ---------- */
function sgBadge(r) {
  if (!r) return '<span class="sgb wait">…</span>';
  if (r.na) return '<span class="sgb na" title="This exchange has no candles for this timeframe">n/a</span>';
  if (r.err) return `<span class="sgb na" title="${r.err.replace(/"/g, '')}">error</span>`;
  const k = r.norm > 0.5 ? 'sb' : r.norm > 0.15 ? 'b' : r.norm < -0.5 ? 'ss' : r.norm < -0.15 ? 's' : 'n';
  const txt = { sb: 'Strong bull', b: 'Bullish', n: 'Neutral', s: 'Bearish', ss: 'Strong bear' }[k];
  const t = r.trend, tcls = !t ? 'tn' : t.dir > 0 ? 'tu' : t.dir < 0 ? 'td' : 'tn';
  const tTxt = !t ? '? Trend n/a' : t.dir > 0 ? '▲ Uptrend' : t.dir < 0 ? '▼ Downtrend' : '↔ ' + t.label;
  const tTitle = t ? `${t.label} · ADX ${t.adx != null ? t.adx.toFixed(0) : '—'} (trend counts when ADX ≥ ${SG_ADX_MIN})` : 'Not enough history for EMA 200';
  return `<div class="trd ${tcls}" title="${tTitle}">${tTxt}</div><span class="sgb ${k}${r.setup ? ' go' : ''}" title="${r.label}: ${r.score > 0 ? '+' : ''}${r.score} of ${r.count} rules · RSI ${r.rsi != null ? r.rsi.toFixed(0) : '—'}${r.setup ? ' · with-trend setup available' : ''}">${txt}<small>${r.setup ? '✓ ' : ''}${r.score > 0 ? '+' : ''}${r.score}</small></span>`;
}
function sgAgreement(res) {
  const vals = SG_TFS.map((tf) => res && res[tf]).filter((r) => r && r.trend);
  if (!vals.length) return { h: '<span class="muted">—</span>', dir: 0 };
  const bull = vals.filter((r) => r.trend.dir > 0).length, bear = vals.filter((r) => r.trend.dir < 0).length;
  const dir = bull > bear ? 1 : bear > bull ? -1 : 0;
  const pct = Math.max(bull, bear) / vals.length;
  const word = dir > 0 ? 'uptrend' : dir < 0 ? 'downtrend' : 'mixed';
  return { h: dir ? `<span class="${dir > 0 ? 'up' : 'down'}"><b>${Math.max(bull, bear)}/${vals.length}</b> ${word}</span><div class="agree"><i class="${dir > 0 ? 'bu' : 'be'}" style="width:${pct * 100}%"></i></div>` : '<span class="muted">mixed</span>', dir };
}
// Only touch the DOM when the markup changed, so buttons stay clickable during the 3-second refresh.
const setHTML = (el, html) => { if (el._h !== html) { el.innerHTML = html; el._h = html; } };
const pctFrom = (x, entry) => fmtPct(((x - entry) / entry) * 100);
function sgSetupHTML(a, tf, st, compact) {
  if (!st) return '';
  const long = st.dir > 0, side = long ? 'Long' : 'Short';
  const acct = typeof paper !== 'undefined' ? Math.max(0, paper.cash) : 10000;
  const riskUsd = acct * 0.01, notional = riskUsd / st.dist, margin = notional / st.levSafe;
  const note = st.wallBeforeTp1 ? `<div class="st-note">${long ? 'Resistance' : 'Support'} at <span class="mono">${fmtP(st.wall)}</span> comes before TP1, so price may stall there.</div>` : '';
  return `<div class="setup ${long ? 'long' : 'short'}${compact ? ' compact' : ''}">
    <div class="st-grid">
      <div><span>Side</span><b class="${long ? 'up' : 'down'}">${side}</b></div>
      <div><span>Entry (EP)</span><b class="mono">${fmtP(st.entry)}</b></div>
      <div><span>Stop loss (SL)</span><b class="mono down">${fmtP(st.sl)}</b><em>${pctFrom(st.sl, st.entry)}</em></div>
      <div><span>Take profit 1</span><b class="mono up">${fmtP(st.tp1)}</b><em>${pctFrom(st.tp1, st.entry)} · 1:1.5</em></div>
      <div><span>Take profit 2</span><b class="mono up">${fmtP(st.tp2)}</b><em>${pctFrom(st.tp2, st.entry)} · 1:3</em></div>
      <div><span>Leverage</span><b class="mono warn">≤ ${st.levSafe}×</b><em>liq ≈ ${fmtP(st.liq)} · never above ${st.levMax}×</em></div>
    </div>
    ${note}
    <div class="st-foot"><span class="muted small">Risking 1% (${fmtUsd(riskUsd)}) of ${fmtUsd(acct)} paper cash: margin ${fmtUsd(margin)} at ${st.levSafe}× (size ${fmtUsd(notional)}).</span>
      <span class="st-btns"><button class="mini" data-chart="${a}|${tf}">Open chart</button><button class="mini primary" data-paper="${a}|${tf}|${st.dir}">Paper trade this</button></span></div>
  </div>`;
}
let sgSelected = null; // {a, tf} chosen from the table
function sgRenderSetupCard() {
  const card = $('#sgSetup'); if (!card) return;
  if (!sgSelected) { card.hidden = true; card._h = null; return; }
  const { a, tf } = sgSelected, r = sg.exId === EX().id && sg.results[a] && sg.results[a][tf];
  card.hidden = false;
  let body;
  if (!r || r.norm == null) body = `<p class="muted small">${r && r.na ? `${EX().name} has no ${SG_TF_LABEL[tf]} candles.` : 'Still scanning…'}</p>`;
  else if (!r.setup) {
    const tl = r.trend ? r.trend.label.toLowerCase() : '';
    const why = {
      neutral: `The indicators show no clear direction on ${a} ${SG_TF_LABEL[tf]} (score ${r.score > 0 ? '+' : ''}${r.score} of ${r.count}).`,
      range: `The signal is ${r.dir > 0 ? 'bullish' : 'bearish'}, but the market is in a <b>${tl}</b> (no confirmed trend, ADX ${r.trend && r.trend.adx != null ? r.trend.adx.toFixed(0) : '—'}). In testing, signals without a trend behind them were unreliable.`,
      against: `The signal is ${r.dir > 0 ? 'bullish' : 'bearish'}, but the market is in a <b>${tl}</b>. In testing, trades against the trend lost the most money.`,
      nohistory: `Not enough history on ${EX().name} to measure the trend (needs about 215 candles).`,
    }[r.block] || '';
    body = `<p class="small">${why} <b>No setup.</b> Waiting is also a decision.</p><div class="st-btns"><button class="mini" data-chart="${a}|${tf}">Open chart</button></div>`;
  }
  else body = sgSetupHTML(a, tf, r.setup);
  setHTML(card, `<div class="card-h">Trade setup · ${a} ${SG_TF_LABEL[tf]} <span class="muted small">${r && r.trend ? r.trend.label + ' · ' : ''}${r && r.label ? r.label : ''}</span><button class="mini" data-close-setup>✕</button></div>${body}`);
}
function sgFindSetup(a, tf, dir) {
  const r = sg.results[a] && sg.results[a][tf];
  if (r && r.setup && r.setup.dir === dir) return r.setup;
  const e = sg.events.find((x) => x.a === a && x.tf === tf && x.ev.dir === dir);
  return e ? e.setup : null;
}
function sgPaperTrade(a, tf, dir) {
  const st = sgFindSetup(a, tf, dir); if (!st) return;
  const num = (x) => Number(x.toFixed(dp(x)));
  setMode('fut');
  $('#pSym').value = a; $('#pLev').value = st.levSafe;
  const acct = Math.max(0, paper.cash), margin = (acct * 0.01) / st.dist / st.levSafe;
  $('#fMargin').value = Math.floor(Math.min(margin, acct / (1 + st.levSafe * FUT_FEE)) * 100) / 100;
  $('#fTp').value = num(st.tp1); $('#fSl').value = num(st.sl);
  updateForms(); showView('paper');
  pMsg(`Setup loaded: ${dir > 0 ? 'Long' : 'Short'} ${a} at ${st.levSafe}× with TP ${fmtP(st.tp1)} and SL ${fmtP(st.sl)}. Check it, then press ${dir > 0 ? 'Buy / Long' : 'Sell / Short'}.`, true);
}

function sgRenderAccuracy() {
  const el = $('#sgAcc'); if (!el) return;
  const A = sg.acc && sg.exId === EX().id ? sg.acc : null;
  if (!A || !A.all.n) { setHTML(el, `<p class="muted small">${sg.scanning ? 'Measuring on this exchange\'s history while scanning…' : 'Runs automatically with each scan.'}</p>`); return; }
  const row = (label, b, cls) => {
    if (!b.n) return `<tr><td>${label}</td><td colspan="3" class="muted">no cases</td></tr>`;
    const R = b.net / b.n, wr = (b.w / b.n) * 100;
    return `<tr class="${cls || ''}"><td>${label}</td><td class="r mono">${b.n.toLocaleString()}</td><td class="r mono ${wr >= 40 ? 'up' : 'down'}">${wr.toFixed(1)}%</td><td class="r mono ${R >= 0 ? 'up' : 'down'}">${R >= 0 ? '+' : ''}${R.toFixed(3)}R</td></tr>`;
  };
  const half = (b) => (b.n ? `${(b.net / b.n >= 0 ? '+' : '')}${(b.net / b.n).toFixed(2)}R` : '—');
  const W = A.with, consistent = W.early.n && W.late.n && W.early.net / W.early.n > 0 && W.late.net / W.late.n > 0;
  setHTML(el, `<p class="small">Every past signal on ${A.ex} (${A.series} coin/timeframe series) replayed as a trade with this page's setup: did <b>TP1</b> or the <b>stop loss</b> come first? Fees included. With TP1 at 1.5× the risk, a <b>40%</b> win rate breaks even.</p>
    <div class="table-wrap"><table class="tbl acc"><thead><tr><th>Signals taken</th><th class="r">Trades</th><th class="r">Win</th><th class="r">Avg</th></tr></thead><tbody>
      ${row('✓ With trend (used)', A.with, 'hl')}${row('No filter', A.all)}${row('✗ Against trend', A.against)}
    </tbody></table></div>
    <p class="small">Consistency of with-trend trades: older half <b>${half(W.early)}</b>, newer half <b>${half(W.late)}</b> per trade. ${consistent ? 'Positive in both halves.' : '<span class="warn">Not positive in both halves, so the edge depends on market conditions.</span>'}</p>
    <p class="muted small">Avg is per trade in R (R = the amount risked). These are past results on limited history (the 15m chart covers only days); they don't promise future results.</p>`);
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
  renderRows($('#sgTable tbody'), rows, 8, sg.filter === 'all' ? 'Scanning…' : `No coins where most timeframes are in a${sg.filter === 'bull' ? 'n uptrend' : ' downtrend'} right now.`);
  sgRenderFeed(); sgRenderStatus(); sgRenderSetupCard(); sgRenderAccuracy();
}
function sgRenderFeed() {
  const list = sg.exId === EX().id ? sg.events.slice() : [];
  const want = sg.filter === 'bull' ? 1 : sg.filter === 'bear' ? -1 : 0;
  const ev = list.filter((e) => (!want || e.ev.dir === want) && (!sg.withOnly || e.withTrend))
    .sort((x, y) => x.ago - y.ago || (y.stats.rate ?? 0) - (x.stats.rate ?? 0) || SG_TFS.indexOf(y.tf) - SG_TFS.indexOf(x.tf));
  if (!ev.length) {
    setHTML($('#sgFeed'), `<p class="muted small">${sg.scanning && !sg.last ? 'Scanning…' : (sg.withOnly ? 'No fresh signals that go with a confirmed trend right now. Untick "With-trend only" to see all signals.' : 'No fresh crossover, breakout or volume events in the last 3 candles.')}</p>`);
    return;
  }
  setHTML($('#sgFeed'), ev.slice(0, 40).map((e) => {
    const s = e.stats, sw = e.statsWith, up = e.ev.dir > 0;
    const trendChip = e.withTrend ? '<span class="tchip ok">✓ With the trend</span>' : e.trend === -e.ev.dir ? '<span class="tchip bad">✗ Against the trend</span>' : '<span class="tchip">No confirmed trend</span>';
    const histWith = sw && sw.n >= 5 ? ` With the trend only: <b class="${sw.rate >= 0.55 ? 'up' : sw.rate < 0.45 ? 'down' : ''}">${Math.round(sw.rate * 100)}%</b> of ${sw.n}.` : '';
    const noSetup = e.withTrend ? '' : `<div class="st-note">No setup: ${e.trend === -e.ev.dir ? 'this goes against the trend' : 'there is no confirmed trend'}. In testing, these lost money.</div>`;
    const hist = s.n >= 5
      ? `Past ${s.n} times on ${e.a} ${SG_TF_LABEL[e.tf]}: price moved ${up ? 'up' : 'down'} ${SG_FORWARD} candles later in <b class="${s.rate >= 0.55 ? 'up' : s.rate < 0.45 ? 'down' : ''}">${Math.round(s.rate * 100)}%</b> of cases (avg ${s.avg >= 0 ? '+' : ''}${s.avg.toFixed(2)}% in the signal's direction).`
      : `Too few past cases (${s.n}) on ${e.a} ${SG_TF_LABEL[e.tf]} to judge reliability.`;
    const when = e.forming ? '<span class="warn">current candle, may still change</span>' : e.ago === 1 ? '1 candle ago' : `${e.ago} candles ago`;
    return `<div class="sgev">
      <div class="sgev-top" data-chart="${e.a}|${e.tf}" tabindex="0"><span class="tf">${SG_TF_LABEL[e.tf]}</span><b>${e.a}</b><span class="tag ${up ? 'bull' : 'bear'}">${up ? 'Bullish' : 'Bearish'}</span>${trendChip}<span class="muted small">${when}</span></div>
      <div>${e.ev.name} at <span class="mono">${fmtP(e.price)}</span></div>
      <div class="muted small">${hist}${histWith}</div>
      ${e.setup ? sgSetupHTML(e.a, e.tf, e.setup, true) : noSetup}
    </div>`;
  }).join(''));
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
  sg.token++; sg.scanning = false; sg.results = {}; sg.events = []; sg.last = 0; sg.exId = null; sg.progress = 0; sgSelected = null; sg.acc = null;
  sgRender(); sgRenderStatus();
  if (sgVisible()) sgScan();
};
$('#sgScan').addEventListener('click', () => sgScan());
$('#sgWith').addEventListener('change', (e) => { sg.withOnly = e.target.checked; sgRender(); });
$('#sgFilter').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  sg.filter = b.dataset.f; $$('#sgFilter button').forEach((x) => x.classList.toggle('active', x === b)); sgRender();
});
$('#sgTable tbody').addEventListener('click', (e) => {
  const td = e.target.closest('td'); if (!td) return;
  const tr = td.parentElement, a = tr.querySelector('b') && tr.querySelector('b').textContent;
  const tf = SG_TFS[td.cellIndex - 3] || (sgSelected && sgSelected.a === a ? sgSelected.tf : '1h');
  if (!a) return;
  sgSelected = { a, tf }; sgRenderSetupCard();
  $('#sgSetup').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('#view-signals').addEventListener('click', (e) => {
  const p = e.target.closest('[data-paper]');
  if (p) { const [a, tf, dir] = p.dataset.paper.split('|'); return sgPaperTrade(a, tf, +dir); }
  const c = e.target.closest('[data-chart]');
  if (c) { const [a, tf] = c.dataset.chart.split('|'); return sgOpen(a, tf); }
  if (e.target.closest('[data-close-setup]')) { sgSelected = null; sgRenderSetupCard(); }
});
$('#sgFeed').addEventListener('keydown', (e) => { const d = e.target.closest('[data-chart]'); if (d && e.key === 'Enter') { const [a, tf] = d.dataset.chart.split('|'); sgOpen(a, tf); } });
setInterval(() => {
  if (!sgVisible()) return;
  sgRender(); // live prices
  if ($('#sgAuto').checked && !sg.scanning && Date.now() - sg.last > SG_REFRESH_MS) sgScan();
}, 3000);
