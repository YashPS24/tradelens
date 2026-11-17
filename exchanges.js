/* Exchange adapters. Each one turns an exchange's public REST + WebSocket API into the same shapes:
 *   ticker: { asset, price, chg (%), high, low, vol (quote currency) }
 *   candle: { t (ms open time), o, h, l, c, v }
 *   trade:  { p, q, sell (taker sold), t (ms) }
 *   book:   { bids: [[price, qty]...] best first, asks: [[price, qty]...] best first }
 */
'use strict';

const ALL_ASSETS = ['BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'LINK', 'DOT', 'LTC', 'TRX'];
const IV_SEC = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };

/* ---------- shared helpers ---------- */
const sockets = {};
let onSocketStatus = () => {};

class Socket {
  constructor(key, url, { onOpen, onMessage, ping, pingMs = 20000 }) {
    const urls = Array.isArray(url) ? url : [url];
    Object.assign(this, { key, urls, ui: 0, onOpen, onMessage, ping, pingMs, retry: 0, closed: false, isOpen: false, everOpened: false });
    sockets[key] = this; this.open();
  }
  open() {
    let ws;
    try { ws = this.ws = new WebSocket(this.urls[this.ui]); } catch { this.ui = (this.ui + 1) % this.urls.length; return setTimeout(() => this.open(), 1000); }
    ws.onopen = () => {
      this.retry = 0; this.isOpen = true; this.everOpened = true; onSocketStatus();
      this.onOpen && this.onOpen(this);
      if (this.ping) this.timer = setInterval(() => this.send(this.ping), this.pingMs);
    };
    ws.onmessage = (e) => { let d = e.data; try { d = JSON.parse(d); } catch {} this.onMessage(d); };
    ws.onclose = () => {
      this.isOpen = false; clearInterval(this.timer);
      if (this.closed) return;
      if (!this.everOpened) this.ui = (this.ui + 1) % this.urls.length; // try the backup domain
      onSocketStatus();
      setTimeout(() => !this.closed && this.open(), Math.min(30000, 1000 * 2 ** this.retry++));
    };
    ws.onerror = () => ws.close();
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(typeof o === 'string' ? o : JSON.stringify(o)); }
  close() { this.closed = true; clearInterval(this.timer); this.ws && this.ws.close(); if (sockets[this.key] === this) delete sockets[this.key]; }
}

class LocalBook {
  constructor(depth = 50) { this.depth = depth; this.reset(); }
  reset() { this.b = new Map(); this.a = new Map(); }
  apply(side, rows) {
    const m = side === 'b' ? this.b : this.a;
    for (const [p, q] of rows) { if (+q === 0) m.delete(+p); else m.set(+p, +q); }
  }
  top(n = 20) {
    const bids = [...this.b].sort((x, y) => y[0] - x[0]), asks = [...this.a].sort((x, y) => x[0] - y[0]);
    // keep the local book bounded
    bids.slice(this.depth).forEach(([p]) => this.b.delete(p)); asks.slice(this.depth).forEach(([p]) => this.a.delete(p));
    return { bids: bids.slice(0, n), asks: asks.slice(0, n) };
  }
}

class NetError extends Error {
  constructor(msg, status, host) { super(msg); this.status = status; this.host = host; }
}
async function getJSON(url) {
  const host = new URL(url).host;
  let r;
  try { r = await fetch(url); } catch { throw new NetError(`Could not reach ${host}`, 0, host); }
  if (!r.ok) throw new NetError(`HTTP ${r.status} from ${host}`, r.status, host);
  return r.json();
}
// Try each host in turn and remember the first one that works.
const goodHost = {};
async function getJSONFrom(id, hosts, path) {
  const order = goodHost[id] ? [goodHost[id], ...hosts.filter((h) => h !== goodHost[id])] : hosts;
  let err;
  for (const h of order) {
    try { const j = await getJSON(h + path); goodHost[id] = h; return j; } catch (e) { err = e; }
  }
  throw err;
}
const chunk = (arr, n) => arr.reduce((o, x, i) => (i % n ? o[o.length - 1].push(x) : o.push([x]), o), []);
const closeAll = (...xs) => () => xs.forEach((x) => (typeof x === 'function' ? x() : x.close()));

/* ---------- Binance ---------- */
const BN_HOSTS = ['https://data-api.binance.vision', 'https://api.binance.com', 'https://api-gcp.binance.com'];
const BN_WS = ['wss://data-stream.binance.vision/stream?streams=', 'wss://stream.binance.com:9443/stream?streams='];
const bnGet = (path) => getJSONFrom('binance', BN_HOSTS, '/api/v3' + path);
const bnWs = (streams) => BN_WS.map((u) => u + streams.join('/'));
const binance = {
  id: 'binance', name: 'Binance', quote: 'USDT', assets: ALL_ASSETS,
  intervals: { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h', '1d': '1d' },
  async snapshot(assets) {
    const syms = assets.map((a) => a + 'USDT');
    const arr = await bnGet(`/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(syms))}`);
    return arr.map((d) => ({ asset: d.symbol.replace(/USDT$/, ''), price: +d.lastPrice, chg: +d.priceChangePercent, high: +d.highPrice, low: +d.lowPrice, vol: +d.quoteVolume }));
  },
  tickers(assets, on) {
    const s = new Socket('tickers', bnWs(assets.map((a) => a.toLowerCase() + 'usdt@ticker')), {
      onMessage: (m) => { const d = m && m.data; if (d) on({ asset: d.s.replace(/USDT$/, ''), price: +d.c, chg: +d.P, high: +d.h, low: +d.l, vol: +d.q }); },
    });
    return closeAll(s);
  },
  async klines(a, iv) {
    const rows = await bnGet(`/klines?symbol=${a}USDT&interval=${this.intervals[iv]}&limit=600`);
    return rows.map((k) => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  },
  chart(a, iv, h) {
    const s = a.toLowerCase() + 'usdt';
    const sock = new Socket('chart', bnWs([`${s}@kline_${this.intervals[iv]}`, `${s}@aggTrade`, `${s}@depth20@100ms`]), {
      onMessage: (m) => {
        if (!m || !m.stream) return; const d = m.data;
        if (m.stream.includes('@kline')) h.kline({ t: d.k.t, o: +d.k.o, h: +d.k.h, l: +d.k.l, c: +d.k.c, v: +d.k.v });
        else if (m.stream.includes('@aggTrade')) h.trade({ p: +d.p, q: +d.q, sell: d.m, t: d.T });
        else h.book({ bids: d.bids.map(([p, q]) => [+p, +q]), asks: d.asks.map(([p, q]) => [+p, +q]) });
      },
    });
    return closeAll(sock);
  },
};

/* ---------- Bybit (spot, v5) ---------- */
const BY_HOSTS = ['https://api.bybit.com', 'https://api.bytick.com'];
const BY_WS = ['wss://stream.bybit.com/v5/public/spot', 'wss://stream.bytick.com/v5/public/spot'];
const byGet = (path) => getJSONFrom('bybit', BY_HOSTS, '/v5/market' + path);
const bybit = {
  id: 'bybit', name: 'Bybit', quote: 'USDT', assets: ALL_ASSETS,
  intervals: { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240', '1d': 'D' },
  async snapshot() {
    const j = await byGet('/tickers?category=spot');
    return j.result.list.filter((x) => x.symbol.endsWith('USDT')).map(bybit._t);
  },
  _t: (x) => ({ asset: x.symbol.replace(/USDT$/, ''), price: +x.lastPrice, chg: +x.price24hPcnt * 100, high: +x.highPrice24h, low: +x.lowPrice24h, vol: +x.turnover24h }),
  _sub: (args) => (s) => chunk(args, 10).forEach((c) => s.send({ op: 'subscribe', args: c })),
  tickers(assets, on) {
    const s = new Socket('tickers', BY_WS, {
      onOpen: this._sub(assets.map((a) => `tickers.${a}USDT`)), ping: { op: 'ping' },
      onMessage: (m) => { if (m && m.topic && m.topic.startsWith('tickers.') && m.data) on(bybit._t(m.data)); },
    });
    return closeAll(s);
  },
  async klines(a, iv) {
    const j = await byGet(`/kline?category=spot&symbol=${a}USDT&interval=${this.intervals[iv]}&limit=1000`);
    return j.result.list.reverse().map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  },
  chart(a, iv, h) {
    const S = a + 'USDT', book = new LocalBook(50);
    const sock = new Socket('chart', BY_WS, {
      onOpen: this._sub([`kline.${this.intervals[iv]}.${S}`, `publicTrade.${S}`, `orderbook.50.${S}`]), ping: { op: 'ping' },
      onMessage: (m) => {
        if (!m || !m.topic) return;
        if (m.topic.startsWith('kline.')) m.data.forEach((k) => h.kline({ t: +k.start, o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }));
        else if (m.topic.startsWith('publicTrade.')) m.data.forEach((t) => h.trade({ p: +t.p, q: +t.v, sell: t.S === 'Sell', t: +t.T }));
        else if (m.topic.startsWith('orderbook.')) {
          if (m.type === 'snapshot') book.reset();
          book.apply('b', m.data.b); book.apply('a', m.data.a); h.book(book.top());
        }
      },
    });
    return closeAll(sock);
  },
};

/* ---------- OKX (v5) ---------- */
const OKX_REST = 'https://www.okx.com/api/v5/market';
const OKX_PUB = 'wss://ws.okx.com:8443/ws/v5/public';
const OKX_BIZ = 'wss://ws.okx.com:8443/ws/v5/business';
const okx = {
  id: 'okx', name: 'OKX', quote: 'USDT', assets: ALL_ASSETS,
  intervals: { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H', '1d': '1Dutc' },
  _t: (x) => ({ asset: x.instId.split('-')[0], price: +x.last, chg: ((x.last - x.open24h) / x.open24h) * 100, high: +x.high24h, low: +x.low24h, vol: +x.volCcy24h }),
  async snapshot() {
    const j = await getJSON(`${OKX_REST}/tickers?instType=SPOT`);
    return j.data.filter((x) => x.instId.endsWith('-USDT')).map(okx._t);
  },
  tickers(assets, on) {
    const s = new Socket('tickers', OKX_PUB, {
      onOpen: (s) => s.send({ op: 'subscribe', args: assets.map((a) => ({ channel: 'tickers', instId: `${a}-USDT` })) }),
      ping: 'ping', pingMs: 25000,
      onMessage: (m) => { if (m && m.arg && m.arg.channel === 'tickers' && m.data) m.data.forEach((x) => on(okx._t(x))); },
    });
    return closeAll(s);
  },
  async klines(a, iv) {
    const j = await getJSON(`${OKX_REST}/candles?instId=${a}-USDT&bar=${this.intervals[iv]}&limit=300`);
    return j.data.reverse().map((k) => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  },
  chart(a, iv, h) {
    const id = `${a}-USDT`, ch = 'candle' + this.intervals[iv];
    const pub = new Socket('chart', OKX_PUB, {
      onOpen: (s) => s.send({ op: 'subscribe', args: [{ channel: 'trades', instId: id }, { channel: 'books5', instId: id }] }),
      ping: 'ping', pingMs: 25000,
      onMessage: (m) => {
        if (!m || !m.arg || !m.data) return;
        if (m.arg.channel === 'trades') m.data.forEach((t) => h.trade({ p: +t.px, q: +t.sz, sell: t.side === 'sell', t: +t.ts }));
        else if (m.arg.channel === 'books5') { const b = m.data[0]; h.book({ bids: b.bids.map((r) => [+r[0], +r[1]]), asks: b.asks.map((r) => [+r[0], +r[1]]) }); }
      },
    });
    const biz = new Socket('chart-candles', OKX_BIZ, {
      onOpen: (s) => s.send({ op: 'subscribe', args: [{ channel: ch, instId: id }] }),
      ping: 'ping', pingMs: 25000,
      onMessage: (m) => { if (m && m.arg && m.arg.channel === ch && m.data) m.data.forEach((k) => h.kline({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] })); },
    });
    return closeAll(pub, biz);
  },
};

/* ---------- Coinbase (Exchange, USD pairs) ---------- */
const CB_REST = 'https://api.exchange.coinbase.com/products';
const CB_WS = 'wss://ws-feed.exchange.coinbase.com';
const coinbase = {
  id: 'coinbase', name: 'Coinbase', quote: 'USD', assets: ALL_ASSETS.filter((a) => a !== 'TRX'),
  intervals: { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': null, '1d': 86400 }, // no 4h candles on Coinbase
  async snapshot(assets) {
    const res = await Promise.allSettled(assets.map(async (a) => {
      const s = await getJSON(`${CB_REST}/${a}-USD/stats`);
      return { asset: a, price: +s.last, chg: ((s.last - s.open) / s.open) * 100, high: +s.high, low: +s.low, vol: s.volume * s.last };
    }));
    return res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  },
  tickers(assets, on) {
    const s = new Socket('tickers', CB_WS, {
      onOpen: (s) => s.send({ type: 'subscribe', product_ids: assets.map((a) => `${a}-USD`), channels: ['ticker', 'heartbeat'] }),
      onMessage: (m) => {
        if (!m || m.type !== 'ticker') return; const p = +m.price;
        on({ asset: m.product_id.split('-')[0], price: p, chg: ((p - m.open_24h) / m.open_24h) * 100, high: +m.high_24h, low: +m.low_24h, vol: m.volume_24h * p });
      },
    });
    return closeAll(s);
  },
  async klines(a, iv) {
    const rows = await getJSON(`${CB_REST}/${a}-USD/candles?granularity=${this.intervals[iv]}`);
    return rows.reverse().map((k) => ({ t: k[0] * 1000, o: +k[3], h: +k[2], l: +k[1], c: +k[4], v: +k[5] }));
  },
  // Coinbase has no public candle or order-book stream: build candles from live trades, poll the book over REST.
  chart(a, iv, h, last) {
    const ms = IV_SEC[iv] * 1000; let cur = last ? { ...last } : null;
    const sock = new Socket('chart', CB_WS, {
      onOpen: (s) => s.send({ type: 'subscribe', product_ids: [`${a}-USD`], channels: ['matches', 'heartbeat'] }),
      onMessage: (m) => {
        if (!m || m.type !== 'match') return;
        const p = +m.price, q = +m.size, t = Date.parse(m.time), start = Math.floor(t / ms) * ms;
        h.trade({ p, q, sell: m.side === 'buy', t });
        if (!cur || start > cur.t) cur = { t: start, o: p, h: p, l: p, c: p, v: q };
        else if (start === cur.t) { cur.h = Math.max(cur.h, p); cur.l = Math.min(cur.l, p); cur.c = p; cur.v += q; }
        else return;
        h.kline({ ...cur });
      },
    });
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const b = await getJSON(`${CB_REST}/${a}-USD/book?level=2`);
        if (!stop) h.book({ bids: b.bids.slice(0, 20).map((r) => [+r[0], +r[1]]), asks: b.asks.slice(0, 20).map((r) => [+r[0], +r[1]]) });
      } catch {}
      if (!stop) timer = setTimeout(poll, 2000);
    };
    let timer = setTimeout(poll, 0);
    return closeAll(sock, () => { stop = true; clearTimeout(timer); });
  },
};

/* ---------- Kraken (WebSocket v2, USD pairs) ---------- */
const KR_REST = 'https://api.kraken.com/0/public';
const KR_WS = 'wss://ws.kraken.com/v2';
const kraken = {
  id: 'kraken', name: 'Kraken', quote: 'USD', assets: ALL_ASSETS,
  intervals: { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440 },
  async snapshot() { return []; }, // the ticker WebSocket sends a snapshot on subscribe
  tickers(assets, on) {
    const s = new Socket('tickers', KR_WS, {
      onOpen: (s) => s.send({ method: 'subscribe', params: { channel: 'ticker', symbol: assets.map((a) => `${a}/USD`) } }),
      ping: { method: 'ping' }, pingMs: 30000,
      onMessage: (m) => {
        if (!m || m.channel !== 'ticker' || !m.data) return;
        m.data.forEach((x) => on({ asset: x.symbol.split('/')[0], price: +x.last, chg: +x.change_pct, high: +x.high, low: +x.low, vol: x.volume * (x.vwap || x.last) }));
      },
    });
    return closeAll(s);
  },
  async klines(a, iv) {
    const j = await getJSON(`${KR_REST}/OHLC?pair=${encodeURIComponent(a + '/USD')}&interval=${this.intervals[iv]}`);
    if (j.error && j.error.length) throw new Error(j.error.join(', '));
    const key = Object.keys(j.result).find((k) => k !== 'last');
    return j.result[key].map((k) => ({ t: k[0] * 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
  },
  chart(a, iv, h) {
    const sym = `${a}/USD`, book = new LocalBook(25);
    const sock = new Socket('chart', KR_WS, {
      onOpen: (s) => {
        s.send({ method: 'subscribe', params: { channel: 'ohlc', symbol: [sym], interval: this.intervals[iv] } });
        s.send({ method: 'subscribe', params: { channel: 'trade', symbol: [sym] } });
        s.send({ method: 'subscribe', params: { channel: 'book', symbol: [sym], depth: 25 } });
      },
      ping: { method: 'ping' }, pingMs: 30000,
      onMessage: (m) => {
        if (!m || !m.channel || !m.data) return;
        if (m.channel === 'ohlc') m.data.forEach((k) => h.kline({ t: Date.parse(k.interval_begin), o: +k.open, h: +k.high, l: +k.low, c: +k.close, v: +k.volume }));
        else if (m.channel === 'trade') m.data.forEach((t) => h.trade({ p: +t.price, q: +t.qty, sell: t.side === 'sell', t: Date.parse(t.timestamp) }));
        else if (m.channel === 'book') {
          const d = m.data[0]; if (m.type === 'snapshot') book.reset();
          book.apply('b', d.bids.map((r) => [r.price, r.qty])); book.apply('a', d.asks.map((r) => [r.price, r.qty])); h.book(book.top());
        }
      },
    });
    return closeAll(sock);
  },
};

const EXCHANGES = { binance, bybit, okx, coinbase, kraken };
