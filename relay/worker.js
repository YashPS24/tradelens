/**
 * TradeLens relay: a Cloudflare Worker that forwards public market-data requests
 * (REST and WebSocket) to crypto exchanges, for networks that block them directly.
 *
 * URL shape:  https://<worker>/h/<exchange-host>/<path>?<query>
 *   e.g.      https://<worker>/h/api.bybit.com/v5/market/tickers?category=spot
 *             wss://<worker>/h/stream.bybit.com/v5/public/spot
 *
 * Only the exchange hosts below and the origins below are allowed, so it can't be used as an open proxy.
 */
const HOSTS = new Set([
  'data-api.binance.vision', 'api.binance.com', 'data-stream.binance.vision',
  'api.bybit.com', 'api.bytick.com', 'stream.bybit.com',
  'www.okx.com', 'ws.okx.com:8443',
  'api.exchange.coinbase.com', 'ws-feed.exchange.coinbase.com',
  'api.kraken.com', 'ws.kraken.com',
]);
const UA = 'Mozilla/5.0 (compatible; TradeLens-relay/1.0)';
const ORIGINS = new Set(['https://yashps24.github.io', 'http://localhost:8765']);

function cors(res, origin) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', origin);
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  h.delete('Set-Cookie');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

export default {
  async fetch(req) {
    const url = new URL(req.url);
    const origin = req.headers.get('Origin') || '';
    if (url.pathname === '/' || url.pathname === '/health') return new Response('TradeLens relay OK', { headers: { 'Access-Control-Allow-Origin': '*' } });
    if (!ORIGINS.has(origin)) return new Response('Origin not allowed', { status: 403 });
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin);

    const m = url.pathname.match(/^\/h\/([^/]+)(\/.*)?$/);
    if (!m || !HOSTS.has(m[1])) return cors(new Response('Host not allowed', { status: 404 }), origin);
    const target = `https://${m[1]}${m[2] || '/'}${url.search}`;

    // WebSocket: hand the upgrade straight through to the exchange.
    // Only forward the headers the exchange needs (copying all of them sends the relay's own Host, which some exchanges reject).
    if ((req.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const headers = new Headers({ Upgrade: 'websocket', 'User-Agent': UA });
      const proto = req.headers.get('Sec-WebSocket-Protocol'); if (proto) headers.set('Sec-WebSocket-Protocol', proto);
      return fetch(target, { headers });
    }
    if (req.method !== 'GET') return cors(new Response('Method not allowed', { status: 405 }), origin);
    // Cloudflare's IPs are shared, so exchanges sometimes rate-limit them: retry a couple of times on HTTP 429.
    let res;
    for (let i = 0; i < 3; i++) {
      res = await fetch(target, { headers: { Accept: 'application/json', 'User-Agent': UA } });
      if (res.status !== 429) break;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
    return cors(res, origin);
  },
};
