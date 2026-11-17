# TradeLens

A real-time crypto market analysis and trading education site. It's a static site (HTML, CSS and JS only) with no backend, no build step and no API keys.

## Features
- **Exchange switcher**: Binance, Bybit, OKX, Coinbase or Kraken, picked from the header (link straight to one with `?ex=bybit`)
- **Markets**: live prices, 24h change, high/low and volume for 12 major coins, streamed over WebSocket
- **Analyze**: candlestick chart (1m–1D) with SMA 20, EMA 50, Bollinger Bands, auto support/resistance, RSI and MACD panes, plus a live order book, a trades tape and a plain-English technical summary
- **Paper Trade**: $10,000 of virtual money at live prices with a 0.1% fee, positions and P&L (stored in the browser)
- **Learn**: 8 lessons with "See it live" links to the chart, a position-size calculator and a quiz

Data comes from each exchange's public market-data API (no keys). Binance, Bybit and OKX quote in USDT; Coinbase and Kraken quote in USD. Coinbase has no 4h candles and no TRX, and its order book refreshes every 2 seconds instead of streaming.

## Run locally
```bash
python3 -m http.server 8765
```
Then open http://localhost:8765

## Publish it on a public domain (free)
Any static host works. Choose one:

**Netlify (fastest):** go to https://app.netlify.com/drop and drag this folder onto the page. You get a public URL right away, and you can add your own domain under *Domain settings*.

**GitHub Pages:** push these files to a GitHub repo, then go to *Settings → Pages → Deploy from branch → main / root*. The site goes live at `https://<user>.github.io/<repo>`.

**Vercel / Cloudflare Pages:** import the repo and choose the "Other / static" preset. There's no build command, and the output directory is `/`.

## Customize
- Coins: edit `ALL_ASSETS` in `exchanges.js` and `NAMES` in `app.js`
- Exchanges: each one is an adapter object in `exchanges.js`; add a new one to `EXCHANGES`
- Lessons and quiz: edit `LESSONS` and `QUIZ` in `app.js`
- Colors: edit the CSS variables in `style.css` `:root`

Educational use only. This is not financial advice.
