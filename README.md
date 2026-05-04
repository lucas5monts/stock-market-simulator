# Stock Simulator

A local-first paper trading experiment with live market quotes, fake-money trades, synthetic options, crypto tickers, a Monte Carlo scenarios page, and a browser-local leaderboard.

This is intentionally not a brokerage product. It is a sandbox for exploring trading UX, portfolio mechanics, and live-data simulation patterns in a small vanilla JavaScript app.

## What It Does

- Uses real ticker symbols and live quote/chart data through a tiny Yahoo Finance proxy.
- Supports fake-money buy, sell, short, and synthetic option trades.
- Tracks cash, buying power, positions, transaction history, and local leaderboard results.
- Includes a separate crypto watch universe and Monte Carlo scenario modeling.
- Stores accounts in `localStorage` with PBKDF2-hashed local passcodes.
- Detects casual localStorage tampering with an integrity stamp.

## Current UX Direction

The dashboard is designed as a restrained paper-trading cockpit:

- The top ticker strip is the watchlist and drives the selected chart/trade ticket.
- The primary surface is the selected symbol chart, not a duplicate net-worth card.
- First-run users see a smaller guided paper-trade state.
- Trades produce a refined fill confirmation.
- Position mode shows selected-position P&L, quantity, average cost, and market value.

## Run It

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:3000/
```

Do not open `public/index.html` directly with `file://`; the app uses native ES modules and API routes.

## Test It

```bash
npm test
```

The test suite uses `node:test` and has no extra dependencies.

## Configuration

Copy `.env.example` to `.env` if you want to change local server settings:

```bash
HOST=127.0.0.1
PORT=3000
CACHE_TTL=45
FETCH_TIMEOUT_MS=5000
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=180
```

## Architecture

```text
server.js                         local static server + quote/chart proxy
public/app.js                     tiny browser entry point
public/modules/app-controller.mjs main app controller/render/event flow
public/modules/api.mjs            browser API wrappers
public/modules/auth.mjs           local passcode hashing
public/modules/constants.mjs      symbols, ranges, storage keys
public/modules/format.mjs         formatting and escaping helpers
public/modules/trading.mjs        pure trade/portfolio math
public/styles.css                 visual system and component styles
test/                             node:test coverage
```

## Important Limits

- The leaderboard is local and experimental. A determined user can still alter browser storage.
- The integrity stamp detects casual edits; it is not real anti-cheat.
- Options are simplified synthetic contracts, not market-realistic pricing.
- Quote data availability depends on Yahoo Finance responses.
- This app should not be used for real financial decisions.

## Security Notes

- The local server binds to `127.0.0.1` by default and sends a restrictive CSP plus common browser hardening headers.
- Quote and chart APIs only accept read methods, validate ticker/range/interval input, and reject upstream chart failures instead of minting synthetic tradable assets.
- Browser-saved account data is normalized on load so tampered names, difficulty modes, watchlists, and refresh intervals cannot flow directly into UI state.
- The passcode protects casual local access only. A real multi-user leaderboard would need server-side accounts and a server-side trade ledger.

## Next Experiments

- Server-side trade ledger for trustworthy competition.
- Better mobile trade ticket with a bottom-sheet interaction.
- Company/crypto context cards with earnings, sector, and news metadata.
- More realistic order lifecycle: pending, filled, rejected, partial fills.
- Portfolio milestones and guided learning prompts after first trade.
