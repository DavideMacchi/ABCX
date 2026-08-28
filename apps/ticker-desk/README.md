# Ticker//Desk

A client-side stock quote terminal. Live prices via Finnhub's free API (REST
polling for open/high/low + a WebSocket for real-time trade ticks), with
watchlists, price alerts, an intraday sparkline, and a simple portfolio
P&L tracker. No backend, no build step — just static HTML/CSS/JS.

## Features

- **Live quotes** — WebSocket push on every trade, REST refresh for
  open/high/low every 15–60s depending on watchlist size.
- **Add by ISIN, ticker, or name** — search Finnhub's symbol lookup and add
  the result to any watchlist.
- **Multiple watchlists** — create, switch between, and delete named
  watchlists; only the active one is subscribed/polled.
- **Sort & filter** — by name, price, or % change; free-text filter by
  ticker or company name.
- **Price alerts** — set an above/below threshold per ticker; get a
  browser notification, an audible beep, and a visual pulse when it's
  crossed. Re-arms automatically once the price moves back across the
  threshold.
- **Sparkline** — a small intraday chart per card built from the last ~60
  live/polled price points.
- **Portfolio mode** — enter quantity + average cost per ticker and see
  live position value and P&L, plus a totals bar for the active watchlist.
  Every USD figure (per-card and in the totals bar) also shows its EUR
  equivalent, converted at a live USD/EUR rate pulled from
  [Frankfurter](https://frankfurter.dev/) (ECB reference rates, free, no
  key) and refreshed every 5 minutes while portfolio mode is on.
- **Theme toggle** — light/dark, persisted per device.
- **CSV export** — export the currently visible (filtered/sorted) quotes,
  including portfolio figures, for the active watchlist.

Everything (API key, watchlists, alerts, portfolio, theme) is stored in
`localStorage` on the visiting device only — nothing is sent anywhere
except direct calls to Finnhub.

## Running it

It's a static site — no build step needed.

```bash
cd apps/ticker-desk
python3 -m http.server 8000
# open http://localhost:8000
```

Or open `index.html` directly in a browser (the Finnhub API calls work
fine from `file://`, though a local server avoids other browser quirks).

On first load you'll be asked for a [Finnhub](https://finnhub.io/register)
API key (free tier). US/major-exchange stocks and ETFs work well on the
free plan; many non-US listings (e.g. Borsa Italiana / Euronext Milan)
require a paid Finnhub plan.

## Deploying to GitHub Pages

1. Repo Settings → Pages → Build and deployment → Deploy from a branch.
2. Pick the branch this app is on, folder `/apps/ticker-desk` (or move
   these three files to the repo root / a dedicated `gh-pages` branch if
   you want a shorter URL).
3. Visit the published URL — the API key prompt appears on first load,
   same as running it locally.

## Files

- `index.html` — page structure and the reusable `<template>` for a card.
- `styles.css` — all styling, including the light/dark theme variables.
- `app.js` — state, Finnhub REST/WebSocket calls, rendering, and all
  feature logic (watchlists, alerts, sparkline, portfolio, CSV export).
