import { CHART_RANGES, CRYPTO_SECTIONS, DEFAULT_WATCHLIST, LEGACY_KEY, MARKET_SECTIONS, STARTING_CASH, STORAGE_KEY } from "./constants.mjs";
import { fetchChart, fetchQuotes } from "./api.mjs";
import { createAuth, verifyPasscode } from "./auth.mjs";
import { escapeHtml, fmt, normalizeSymbol, qtyFmt } from "./format.mjs";
import { estimateOptionPremium, getMetrics as calculateMetrics, markOption, positionsCount, realizedShortCashDelta, shortAccountValue, shortLiability } from "./trading.mjs";

let db = loadDb();
let session = db.session || null;
let quotes = {};
let chart = [];
let selectedSymbol = "AAPL";
let tradeSide = "buy";
let chartRange = "1mo";
let activePage = "dashboard";
let sidebarCollapsed = false;
let lastRefresh = null;
let marketDataStatus = "loading";
let toastTimer = null;
let chartRequestId = 0;
let refreshTimer = null;
let integrityWarningShown = false;
let chartAnimationFrame = null;
let previousPrices = {};
let chartHoverRatio = null;
let lastFill = null;
let commandPaletteOpen = false;
let scenarioSymbol = "AAPL";
let scenarioSide = "buy";
let scenarioQty = 10;
let scenarioMove = 8;
let timeMachineEvent = "ai-run";
let timeMachineStep = 18;
let timeMachineTimer = null;

const TIME_MACHINE_EVENTS = {
  "ai-run": {
    label: "AI Momentum Run",
    symbol: "NVDA",
    drift: 1.018,
    volatility: 0.024,
    start: 126,
    note: "A fast trend with violent pullbacks.",
  },
  "crash-tape": {
    label: "Crash Tape",
    symbol: "SPY",
    drift: 0.986,
    volatility: 0.038,
    start: 482,
    note: "Liquidity fades, gaps get larger, patience matters.",
  },
  "crypto-cycle": {
    label: "Crypto Mania",
    symbol: "BTC-USD",
    drift: 1.01,
    volatility: 0.055,
    start: 64000,
    note: "A 24/7 tape where sizing beats conviction.",
  },
};

const STRESS_SCENARIOS = [
  { name: "Market -5%", equity: -0.05, crypto: -0.08, volatility: 1.15 },
  { name: "Tech -10%", equity: -0.1, crypto: -0.06, volatility: 1.25 },
  { name: "Crypto -20%", equity: -0.02, crypto: -0.2, volatility: 1.35 },
  { name: "Short squeeze", equity: 0.04, crypto: 0.06, short: 0.18, volatility: 1.2 },
  { name: "Vol spike", equity: -0.03, crypto: -0.08, volatility: 1.55 },
];

function loadDb() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) {
      const normalized = normalizeDb(saved);
      normalized.tampered = Boolean(saved.integrityVersion === 1 && saved.integrity && saved.integrity !== integrityFor(saved));
      return normalized;
    }
    const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY));
    if (legacy) return normalizeDb(legacy);
  } catch {
    // Empty local storage is fine.
  }
  return { users: {}, session: null };
}

function normalizeDb(source) {
  const users = source.users && typeof source.users === "object" && !Array.isArray(source.users) ? source.users : {};
  const next = { users: {}, session: normalizeAccountName(source.session) || null };
  if (source.integrity) next.integrity = source.integrity;
  if (source.integrityVersion) next.integrityVersion = source.integrityVersion;
  Object.entries(users).forEach(([key, user]) => {
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      return;
    }
    user.name = normalizeAccountName(user.name || key) || "trader";
    user.difficulty = STARTING_CASH[user.difficulty] ? user.difficulty : "easy";
    user.watchlist = Array.isArray(user.watchlist) && user.watchlist.length ? user.watchlist : [...DEFAULT_WATCHLIST];
    user.watchlist = [...new Set(user.watchlist.map(normalizeSymbol).filter(Boolean))].slice(0, 32);
    if (!user.watchlist.length) user.watchlist = [...DEFAULT_WATCHLIST];
    user.holdings = user.holdings || {};
    user.shorts = user.shorts || {};
    user.options = Array.isArray(user.options) ? user.options : [];
    user.history = Array.isArray(user.history) ? user.history : [];
    user.createdAt = user.createdAt || Date.now();
    const refreshSeconds = Number(user.settings?.refreshSeconds || 45);
    user.settings = {
      defaultSymbol: normalizeSymbol(user.settings?.defaultSymbol) || user.watchlist[0] || "AAPL",
      refreshSeconds: [15, 30, 45, 60, 120].includes(refreshSeconds) ? refreshSeconds : 45,
      defaultRange: CHART_RANGES[user.settings?.defaultRange] ? user.settings.defaultRange : "1mo",
    };
    if (!user.pinHash && user.pin) {
      user.needsPasscodeUpgrade = true;
    }
    if (user.pinHash && !user.pinKdf) {
      user.needsPasscodeUpgrade = true;
    }
    next.users[user.name] = user;
  });
  if (next.session && !next.users[next.session]) next.session = null;
  return next;
}

function normalizeAccountName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 24);
}

function saveDb() {
  db.session = session;
  db.integrityVersion = 1;
  db.integrity = integrityFor(db);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
}

function integrityFor(source) {
  return fnv1a(stableStringify({ session: source.session || null, users: source.users || {} }));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((key) => key !== "integrity" && key !== "tampered")
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function currentUser() {
  return session ? db.users[session] : null;
}

function requiresPasscode(user) {
  return Boolean(user && (user.needsPasscodeUpgrade || !sessionStorage.getItem(`stock-simulator-auth:${user.name}`)));
}

function makeUser(name, auth, difficulty) {
  return {
    name,
    ...auth,
    difficulty,
    cash: STARTING_CASH[difficulty],
    watchlist: [...DEFAULT_WATCHLIST],
    holdings: {},
    shorts: {},
    options: [],
    history: [],
    settings: {
      defaultSymbol: "AAPL",
      refreshSeconds: 45,
      defaultRange: "1mo",
    },
    createdAt: Date.now(),
  };
}

function notify(message) {
  const existing = document.querySelector(".toast");
  if (existing) existing.remove();
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.remove(), 2600);
}

function showFillConfirmation(fill) {
  if (!fill) return;
  const existing = document.querySelector(".fill-confirm");
  if (existing) existing.remove();
  const node = document.createElement("div");
  node.className = "fill-confirm";
  const status = document.createElement("span");
  status.textContent = "Filled";
  const summary = document.createElement("strong");
  summary.textContent = `${fill.side.toUpperCase()} ${qtyFmt.format(fill.qty)} ${fill.symbol}`;
  const price = document.createElement("em");
  price.textContent = `@ ${fmt.format(fill.price)}`;
  node.append(status, summary, price);
  document.body.appendChild(node);
  requestAnimationFrame(() => node.classList.add("show"));
  setTimeout(() => node.remove(), 3600);
}

function isEditingForm() {
  const element = document.activeElement;
  return Boolean(element && ["INPUT", "SELECT", "TEXTAREA"].includes(element.tagName));
}

function app() {
  const user = currentUser();
  if (!user || requiresPasscode(user)) {
    session = null;
    saveDb();
    renderLogin();
    return;
  }
  selectedSymbol = selectedSymbol || currentUser().settings.defaultSymbol || "AAPL";
  chartRange = CHART_RANGES[chartRange] ? chartRange : currentUser().settings.defaultRange || "1mo";
  if (!CHART_RANGES[chartRange]) chartRange = "1mo";
  renderDashboard();
  if (db.tampered && !integrityWarningShown) {
    integrityWarningShown = true;
    notify("Saved account data changed outside the app. Treat leaderboard results with caution.");
  }
  refreshQuotes();
  refreshChart(selectedSymbol);
  scheduleRefresh();
}

function renderLogin() {
  document.querySelector("#app").innerHTML = `
    <section class="login-wrap">
      <form class="login-panel" id="loginForm">
        <span class="eyebrow">Fake money. Real tickers.</span>
        <h1>Stock Simulator</h1>
        <p>Build a paper portfolio with live market quotes, short positions, synthetic options, crypto tickers, and a browser leaderboard.</p>
        <label class="field">
          <span>Username</span>
          <input id="username" autocomplete="username" required maxlength="24" placeholder="trader name" />
        </label>
        <label class="field">
          <span>Local passcode</span>
          <input id="pin" autocomplete="current-password" required maxlength="32" type="password" placeholder="4+ characters" />
        </label>
        <div class="difficulty" id="difficulty">
          <button type="button" data-mode="easy" class="active"><strong>Easy</strong><span>${fmt.format(STARTING_CASH.easy)}</span></button>
          <button type="button" data-mode="medium"><strong>Medium</strong><span>${fmt.format(STARTING_CASH.medium)}</span></button>
          <button type="button" data-mode="expert"><strong>Expert</strong><span>${fmt.format(STARTING_CASH.expert)}</span></button>
        </div>
        <button class="primary wide" type="submit">Enter Market</button>
      </form>
    </section>
  `;
  let difficulty = "easy";
  document.querySelector("#difficulty").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    difficulty = button.dataset.mode;
    document.querySelectorAll("#difficulty button").forEach((item) => item.classList.toggle("active", item === button));
  });
  document.querySelector("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = document.querySelector("#username").value.trim().toLowerCase();
    const pin = document.querySelector("#pin").value;
    if (!name) return notify("Enter a username.");
    if (pin.length < 4) return notify("Use a passcode with at least 4 characters.");
    if (db.users[name] && !(await verifyPasscode(db.users[name], pin))) return notify("That username already exists with a different passcode.");
    if (!db.users[name]) db.users[name] = makeUser(name, await createAuth(pin), difficulty);
    if (db.users[name].needsPasscodeUpgrade) {
      Object.assign(db.users[name], await createAuth(pin));
      delete db.users[name].pin;
      delete db.users[name].needsPasscodeUpgrade;
    }
    session = name;
    sessionStorage.setItem(`stock-simulator-auth:${name}`, "1");
    saveDb();
    app();
  });
}

function renderDashboard() {
  const user = currentUser();
  const metrics = getMetrics(user);
  const pageTitle = {
    dashboard: "Trade",
    market: "Live Market",
    crypto: "Crypto",
    montecarlo: "Scenarios",
    lab: "Trading Lab",
    account: "Account",
    settings: "Settings",
  }[activePage];
  document.querySelector("#app").innerHTML = `
    <section class="app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}">
      <header class="topbar">
        <div class="brand">
          <button class="brand-mark" id="sidebarToggle" title="Toggle sidebar" aria-label="Toggle sidebar" type="button"><span class="toggle-icon" aria-hidden="true"></span></button>
          <div>
            <h1>Stock Simulator</h1>
            <p><span class="paper-mark">Paper Trading</span> · ${escapeHtml(user.name)} · ${escapeHtml(user.difficulty)} mode</p>
          </div>
        </div>
        <div class="account-bar">
          <button class="live-control ${marketDataStatus === "stale" ? "stale" : ""}" id="liveBtn" title="Click to refresh quotes" type="button"><span class="status-dot"></span>${marketDataStatus === "stale" ? "Stale" : "Live"}</button>
          <button class="account-chip ${activePage === "account" ? "active" : ""}" data-page="account">${escapeHtml(user.name.slice(0, 2).toUpperCase())}</button>
          <button class="ghost" id="logoutBtn">Log Out</button>
        </div>
      </header>
      <section class="market-strip" aria-label="Market snapshot">
        ${marketStrip(user).join("")}
      </section>
      <div class="app-layout">
        <aside class="sidebar">
          <div class="rail-label"><span>Workspace</span></div>
          <button class="side-link ${activePage === "dashboard" ? "active" : ""}" data-page="dashboard"><strong>Trade</strong></button>
          <button class="side-link ${activePage === "market" ? "active" : ""}" data-page="market"><strong>Live Market</strong></button>
          <button class="side-link ${activePage === "crypto" ? "active" : ""}" data-page="crypto"><strong>Crypto</strong></button>
          <button class="side-link ${activePage === "montecarlo" ? "active" : ""}" data-page="montecarlo"><strong>Scenarios</strong></button>
          <button class="side-link ${activePage === "lab" ? "active" : ""}" data-page="lab"><strong>Lab</strong></button>
          <button class="side-link ${activePage === "account" ? "active" : ""}" data-page="account"><strong>Account</strong></button>
          <button class="side-link ${activePage === "settings" ? "active" : ""}" data-page="settings"><strong>Settings</strong></button>
          <div class="sidebar-card">
            <span class="label">Mode</span>
            <strong>${escapeHtml(user.difficulty)}</strong>
            <span class="muted">${fmt.format(STARTING_CASH[user.difficulty])} start</span>
          </div>
        </aside>
        <div class="dashboard">
          ${activePage === "dashboard" ? "" : `<section class="page-title">
            <div>
              <h2>${pageTitle}</h2>
            </div>
            <div class="page-actions">
            </div>
          </section>`}
          ${activePage === "dashboard" ? dashboardPage(user, metrics) : ""}
          ${activePage === "market" ? liveMarketPage(user) : ""}
          ${activePage === "crypto" ? cryptoPage(user) : ""}
          ${activePage === "montecarlo" ? monteCarloPage(metrics) : ""}
          ${activePage === "lab" ? labPage(user, metrics) : ""}
          ${activePage === "account" ? accountPage(user, metrics) : ""}
          ${activePage === "settings" ? settingsPage(user) : ""}
        </div>
      </div>
      <nav class="mobile-nav" aria-label="Main sections">
        <button data-page="dashboard" class="${activePage === "dashboard" ? "active" : ""}">Trade</button>
        <button data-page="market" class="${activePage === "market" ? "active" : ""}">Market</button>
        <button data-page="crypto" class="${activePage === "crypto" ? "active" : ""}">Crypto</button>
        <button data-page="montecarlo" class="${activePage === "montecarlo" ? "active" : ""}">Scenarios</button>
        <button data-page="lab" class="${activePage === "lab" ? "active" : ""}">Lab</button>
        <button data-page="account" class="${activePage === "account" ? "active" : ""}">Account</button>
        <button data-page="settings" class="${activePage === "settings" ? "active" : ""}">Settings</button>
      </nav>
      ${commandPaletteOpen ? commandPalette(user) : ""}
    </section>
  `;
  bindDashboard();
  drawSparklines();
  if (activePage === "dashboard") drawChart();
  if (activePage === "montecarlo") runMonteCarlo();
  if (activePage === "lab") {
    drawPortfolioMap(user);
    drawTimeMachine();
    updateScenarioPreview();
  }
  updateOrderPreview();
}

function marketStrip(user) {
  return user.watchlist.slice(0, 8).map((symbol) => {
    const quote = quotes[symbol];
    const change = quote?.changePercent || 0;
    const tone = change >= 0 ? "up" : "down";
    const tick = quote && previousPrices[symbol] ? (quote.price > previousPrices[symbol] ? "tick-up" : quote.price < previousPrices[symbol] ? "tick-down" : "") : "";
    return `
      <button class="strip-item ${symbol === selectedSymbol ? "active" : ""} ${tick}" data-strip-symbol="${escapeHtml(symbol)}" type="button">
        <canvas class="sparkline" data-spark-symbol="${escapeHtml(symbol)}" width="220" height="64"></canvas>
        <span class="strip-symbol">${escapeHtml(symbol)}</span>
        <strong>${quote ? fmt.format(quote.price) : "..."}</strong>
        <em class="${tone}">${quote ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "-"}</em>
      </button>
    `;
  });
}

function dashboardPage(user, metrics) {
  const quote = quotes[selectedSymbol];
  const hasActivity = positionsCount(user) > 0 || user.history.length > 0;
  const selectedPosition = selectedPositionSnapshot(user, selectedSymbol);
  const buyingPower = user.cash + Object.values(user.shorts).reduce((sum, position) => sum + (position.margin || 0), 0);
  const dayPnl = Object.entries(user.holdings).reduce((sum, [symbol, position]) => {
    const item = quotes[symbol];
    if (!item) return sum;
    return sum + ((item.price || 0) - (item.previousClose || item.price || 0)) * position.qty;
  }, 0);
  const chartChange = quote?.changePercent || 0;
  const chartTone = chartChange >= 0 ? "up" : "down";
  return `
    <section class="stats-grid">
      ${stat("Cash", fmt.format(user.cash))}
      ${stat("Buying Power", fmt.format(buyingPower))}
      ${stat("Day P&L", `${dayPnl >= 0 ? "+" : ""}${fmt.format(dayPnl)}`, dayPnl >= 0 ? "up" : "down")}
      ${stat("Total Return", `${metrics.returnPct >= 0 ? "+" : ""}${metrics.returnPct.toFixed(2)}%`, metrics.returnPct >= 0 ? "up" : "down")}
    </section>
    <section class="main-grid">
      <div class="panel market-panel" id="market">
        <div class="chart-hero ${hasActivity ? "" : "is-empty"}">
          <div>
            <span class="eyebrow">${hasActivity ? "Selected market" : "First position"}</span>
            <h2>${hasActivity ? escapeHtml(selectedSymbol) : "Start your first paper position"}</h2>
            <p class="muted">${hasActivity ? quoteSubhead(selectedSymbol) : `${escapeHtml(selectedSymbol)} is ready. Choose a size in the trade ticket and place a small fake-money trade.`}</p>
            ${hasActivity ? "" : `<button class="primary first-trade-button" id="firstTradeBtn" type="button">Place your first trade</button>`}
          </div>
          <div class="chart-price">
            <strong>${quote ? fmt.format(quote.price) : "Loading"}</strong>
            <span class="${chartTone}">${quote ? `${chartChange >= 0 ? "+" : ""}${chartChange.toFixed(2)}%` : "-"}</span>
          </div>
        </div>
        <div class="chart-toolbar">
          <div class="range-tabs">
            ${Object.entries(CHART_RANGES).map(([range, item]) => `<button data-range="${range}" class="${chartRange === range ? "active" : ""}">${item.label}</button>`).join("")}
          </div>
          <form class="search" id="searchForm">
            <input id="symbolInput" placeholder="Add symbol" maxlength="18" />
            <button class="ghost add-symbol" type="submit">Add</button>
          </form>
        </div>
        <div class="chart-wrap">
          <canvas id="chartCanvas" width="1000" height="460"></canvas>
          <div class="chart-chip" id="chartHoverChip"></div>
        </div>
      </div>
      <aside class="panel sticky-panel" id="trade">
        <div class="panel-head">
          <h2>Trade Ticket</h2>
          <span class="pill">${escapeHtml(selectedSymbol)}</span>
        </div>
        ${tradeTicket()}
        ${selectedPosition ? positionPanel(selectedPosition) : marketContextPanel(selectedSymbol, quote)}
      </aside>
      <section class="panel" id="portfolio">
        <div class="panel-head"><h2>Portfolio</h2><span class="muted">${positionsCount(user)} open</span></div>
        <div class="stack">${portfolioRows(user) || `<div class="empty">No open positions yet.</div>`}</div>
      </section>
      <section class="panel" id="leaderboard">
        <div class="panel-head"><h2>Leaderboard</h2><span class="muted">Saved on this browser</span></div>
        <div class="stack">${leaderboardRows()}</div>
      </section>
      <section class="panel history-panel" id="history">
        <div class="panel-head"><h2>History</h2><span class="muted">${user.history.length} trades</span></div>
        <div class="stack">${historyRows(user) || `<div class="empty">Your trades will appear here.</div>`}</div>
      </section>
    </section>
  `;
}

function accountPage(user, metrics) {
  const joined = new Date(user.createdAt).toLocaleDateString();
  return `
    <section class="account-grid">
      <div class="panel profile-panel">
        <div class="profile-avatar">${escapeHtml(user.name.slice(0, 2).toUpperCase())}</div>
        <div>
          <span class="eyebrow">Trader profile</span>
          <h2>${escapeHtml(user.name)}</h2>
          <p class="muted">${escapeHtml(user.difficulty)} mode · Joined ${joined}</p>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Account Value</h2><span class="pill">${metrics.returnPct >= 0 ? "Profitable" : "Drawdown"}</span></div>
        <div class="metric-list">
          ${metricRow("Starting cash", fmt.format(metrics.start))}
          ${metricRow("Cash available", fmt.format(user.cash))}
          ${metricRow("Net worth", fmt.format(metrics.netWorth))}
          ${metricRow("Total return", `${metrics.returnPct >= 0 ? "+" : ""}${metrics.returnPct.toFixed(2)}%`)}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Trading Activity</h2><span class="muted">${user.history.length} fills</span></div>
        <div class="metric-list">
          ${metricRow("Open positions", positionsCount(user))}
          ${metricRow("Watchlist", user.watchlist.length)}
          ${metricRow("Long positions", Object.keys(user.holdings).length)}
          ${metricRow("Short positions", Object.keys(user.shorts).length)}
          ${metricRow("Option contracts", user.options.length)}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Account Actions</h2><span class="muted">Local browser account</span></div>
        <div class="action-stack">
          <button class="primary" id="exportBtn" type="button">Export Account Data</button>
          <button class="danger" id="resetBtn" type="button">Reset Account</button>
        </div>
      </div>
    </section>
  `;
}

function liveMarketPage(user) {
  return `
    <section class="market-board">
      ${Object.entries(MARKET_SECTIONS)
        .map(([section, symbols]) => `
          <div class="panel">
            <div class="panel-head">
              <h2>${escapeHtml(section)}</h2>
              <span class="muted">${symbols.length} symbols</span>
            </div>
            <div class="quote-table">
              ${symbols.map((symbol) => liveQuoteRow(symbol, user)).join("")}
            </div>
          </div>
        `)
        .join("")}
    </section>
  `;
}

function cryptoPage(user) {
  const cryptoSymbols = Object.values(CRYPTO_SECTIONS).flat();
  const marketCap = cryptoSymbols.reduce((sum, symbol) => sum + (quotes[symbol]?.price || 0), 0);
  return `
    <section class="crypto-hero">
      <div>
        <span class="eyebrow">24/7 market</span>
        <h2>Crypto Desk</h2>
        <p class="muted">Live crypto pairs are tracked separately from equities and ETFs, with their own watch universe.</p>
      </div>
      <div class="crypto-pulse">
        <span class="label">Tracked spot basket</span>
        <strong>${fmt.format(marketCap)}</strong>
      </div>
    </section>
    <section class="market-board crypto-board">
      ${Object.entries(CRYPTO_SECTIONS)
        .map(([section, symbols]) => `
          <div class="panel">
            <div class="panel-head">
              <h2>${escapeHtml(section)}</h2>
              <span class="muted">${symbols.length} pairs</span>
            </div>
            <div class="quote-table">
              ${symbols.map((symbol) => liveQuoteRow(symbol, user, "crypto")).join("")}
            </div>
          </div>
        `)
        .join("")}
    </section>
  `;
}

function liveQuoteRow(symbol, user, assetClass = "equity") {
  const quote = quotes[symbol];
  const change = quote?.changePercent || 0;
  const tone = change >= 0 ? "up" : "down";
  return `
    <div class="quote-row ${assetClass === "crypto" ? "crypto-row" : ""}">
      <button class="quote-main" data-market-symbol="${escapeHtml(symbol)}" type="button">
        <strong>${escapeHtml(symbol)}</strong>
        <span class="muted">${quote ? escapeHtml(quote.name || symbol) : "Loading quote"}</span>
      </button>
      <div class="right">
        <strong>${quote ? fmt.format(quote.price) : "-"}</strong>
        <span class="${tone}">${quote ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "-"}</span>
      </div>
      <button class="ghost watch-add" data-watch-symbol="${escapeHtml(symbol)}" type="button">${user.watchlist.includes(symbol) ? "Added" : assetClass === "crypto" ? "Track" : "Watch"}</button>
    </div>
  `;
}

function monteCarloPage(metrics) {
  return `
    <section class="monte-grid">
      <form class="panel monte-form" id="monteForm">
        <div class="panel-head"><h2>Simulation Inputs</h2><span class="muted">1,000 paths</span></div>
        <label class="field">
          <span>Starting value</span>
          <input id="mcStart" type="number" min="1" step="100" value="${Math.round(metrics.netWorth)}" />
        </label>
        <div class="row-2">
          <label class="field">
            <span>Years</span>
            <input id="mcYears" type="number" min="1" max="40" step="1" value="10" />
          </label>
          <label class="field">
            <span>Annual return %</span>
            <input id="mcReturn" type="number" min="-50" max="80" step="0.1" value="8" />
          </label>
        </div>
        <div class="row-2">
          <label class="field">
            <span>Volatility %</span>
            <input id="mcVolatility" type="number" min="0" max="100" step="0.1" value="18" />
          </label>
          <label class="field">
            <span>Monthly contribution</span>
            <input id="mcContribution" type="number" min="0" step="25" value="0" />
          </label>
        </div>
        <button class="primary wide" type="submit">Run Simulation</button>
      </form>
      <div class="panel monte-results">
        <div class="panel-head"><h2>Projected Outcomes</h2><span class="pill">Monte Carlo</span></div>
        <div class="stats-grid compact" id="mcStats">
          ${stat("Median", "-")}
          ${stat("Best 10%", "-")}
          ${stat("Worst 10%", "-")}
          ${stat("Loss Risk", "-")}
        </div>
        <div class="chart-wrap monte-chart"><canvas id="monteCanvas" width="1000" height="420"></canvas></div>
      </div>
    </section>
  `;
}

function labPage(user, metrics) {
  return `
    <section class="lab-grid">
      ${dailyBriefPanel(user, metrics)}
      ${marketMoodPanel(user)}
      ${riskEnginePanel(user, metrics)}
      ${scenarioBuilderPanel(user)}
      ${coachPanel(user, metrics)}
      ${portfolioMapPanel(user)}
      ${timeMachinePanel()}
      ${tradeReplayPanel(user)}
      ${achievementsPanel(user, metrics)}
    </section>
  `;
}

function dailyBriefPanel(user, metrics) {
  const best = bestMover(user);
  const risk = riskScore(user, metrics);
  const netTone = metrics.returnPct >= 0 ? "up" : "down";
  return `
    <section class="panel lab-hero">
      <div>
        <span class="eyebrow">Daily brief</span>
        <h2>${metrics.returnPct >= 0 ? "You are playing offense." : "Capital defense mode."}</h2>
        <p class="muted">${dailyBriefText(user, metrics, best, risk)}</p>
      </div>
      <div class="brief-stack">
        ${stat("Net Worth", fmt.format(metrics.netWorth), netTone)}
        ${stat("Risk Score", `${risk}/100`, risk > 70 ? "down" : risk > 42 ? "warn" : "up")}
      </div>
    </section>
  `;
}

function dailyBriefText(user, metrics, best, risk) {
  if (!positionsCount(user)) return "No positions yet. Use the lab to rehearse risk before the first fill.";
  const mover = best ? `${best.symbol} is your loudest ticker at ${best.change >= 0 ? "+" : ""}${best.change.toFixed(2)}%.` : "Live movers are still loading.";
  const exposure = metrics.netWorth ? (metrics.exposure / metrics.netWorth) * 100 : 0;
  return `${mover} Gross exposure is ${exposure.toFixed(0)}% of net worth, with a ${risk > 70 ? "high" : risk > 42 ? "moderate" : "controlled"} risk profile.`;
}

function marketMoodPanel(user) {
  const symbols = [...new Set([...user.watchlist, ...Object.values(MARKET_SECTIONS).flat(), ...Object.values(CRYPTO_SECTIONS).flat()])];
  const live = symbols.map((symbol) => ({ symbol, quote: quotes[symbol] })).filter((item) => item.quote && Number.isFinite(item.quote.changePercent));
  const green = live.filter((item) => item.quote.changePercent >= 0).length;
  const red = live.length - green;
  const leader = live.slice().sort((a, b) => b.quote.changePercent - a.quote.changePercent)[0];
  const laggard = live.slice().sort((a, b) => a.quote.changePercent - b.quote.changePercent)[0];
  const breadth = live.length ? (green / live.length) * 100 : 0;
  return `
    <section class="panel mood-panel">
      <div class="panel-head"><h2>Market Mood</h2><span class="pill">${live.length ? `${green}/${live.length} green` : "Loading"}</span></div>
      <div class="mood-meter"><span style="width: ${Math.max(3, breadth)}%"></span></div>
      <div class="mood-grid">
        ${metricRow("Risk Meter", breadth >= 58 ? "Risk-on" : breadth <= 42 ? "Risk-off" : "Mixed tape")}
        ${metricRow("Best mover", leader ? `${escapeHtml(leader.symbol)} ${signedPct(leader.quote.changePercent)}` : "-")}
        ${metricRow("Worst mover", laggard ? `${escapeHtml(laggard.symbol)} ${signedPct(laggard.quote.changePercent)}` : "-")}
        ${metricRow("Crypto heat", cryptoHeat())}
      </div>
    </section>
  `;
}

function riskEnginePanel(user, metrics) {
  return `
    <section class="panel risk-panel">
      <div class="panel-head">
        <div><h2>Risk Engine</h2><span class="muted">Portfolio stress tests</span></div>
        <span class="pill">${fmt.format(metrics.exposure)} exposure</span>
      </div>
      <div class="risk-grid">
        ${STRESS_SCENARIOS.map((scenario) => stressCard(user, metrics, scenario)).join("")}
      </div>
    </section>
  `;
}

function stressCard(user, metrics, scenario) {
  const stressed = stressNetWorth(user, scenario);
  const delta = stressed - metrics.netWorth;
  const tone = delta >= 0 ? "up" : "down";
  return `
    <div class="risk-card">
      <span class="label">${escapeHtml(scenario.name)}</span>
      <strong class="${tone}">${delta >= 0 ? "+" : ""}${fmt.format(delta)}</strong>
      <span class="muted">Net worth ${fmt.format(stressed)}</span>
    </div>
  `;
}

function scenarioBuilderPanel(user) {
  const normalized = normalizeSymbol(scenarioSymbol) || selectedSymbol;
  scenarioSymbol = normalized;
  const quote = quotes[normalized];
  return `
    <section class="panel scenario-panel">
      <div class="panel-head">
        <div><h2>Scenario Builder</h2><span class="muted">Preview a trade before it touches cash</span></div>
        <span class="pill">${escapeHtml(normalized)}</span>
      </div>
      <form class="scenario-form" id="scenarioForm">
        <div class="row-2">
          <label class="field"><span>Symbol</span><input id="scenarioSymbolInput" maxlength="18" value="${escapeHtml(normalized)}" /></label>
          <label class="field"><span>Action</span><select id="scenarioSideInput">
            ${["buy", "short", "call", "put"].map((side) => `<option value="${side}" ${scenarioSide === side ? "selected" : ""}>${side.toUpperCase()}</option>`).join("")}
          </select></label>
        </div>
        <div class="row-2">
          <label class="field"><span>Size</span><input id="scenarioQtyInput" type="number" min="0.0001" step="0.0001" value="${scenarioQty}" /></label>
          <label class="field"><span>Move %</span><input id="scenarioMoveInput" type="number" min="-80" max="120" step="0.5" value="${scenarioMove}" /></label>
        </div>
      </form>
      <div class="scenario-output" id="scenarioOutput">${scenarioPreview(user, normalized, quote)}</div>
    </section>
  `;
}

function scenarioPreview(user, symbol, quote) {
  const price = quote?.price || quotes[selectedSymbol]?.price || 100;
  const qty = Math.max(0, Number(scenarioQty) || 0);
  const move = Number(scenarioMove) || 0;
  const movedPrice = Math.max(0.01, price * (1 + move / 100));
  const premium = estimateOptionPremium(price);
  const movedPremium = scenarioSide === "put"
    ? Math.max(0.05, premium + Math.max(0, price - movedPrice) * 0.62 - premium * 0.18)
    : Math.max(0.05, premium + Math.max(0, movedPrice - price) * 0.62 - premium * 0.18);
  const cost = ["call", "put"].includes(scenarioSide) ? qty * premium * 100 : qty * price * (scenarioSide === "short" ? 0.5 : 1);
  const pnl = scenarioSide === "buy"
    ? (movedPrice - price) * qty
    : scenarioSide === "short"
      ? (price - movedPrice) * qty
      : (movedPremium - premium) * qty * 100;
  const afterCash = user.cash - cost;
  return `
    ${metricRow("Entry", `${escapeHtml(symbol)} @ ${fmt.format(price)}`)}
    ${metricRow("Projected price", fmt.format(movedPrice))}
    ${metricRow("Cash required", fmt.format(cost))}
    ${metricRow("Scenario P&L", `<span class="${pnl >= 0 ? "up" : "down"}">${pnl >= 0 ? "+" : ""}${fmt.format(pnl)}</span>`)}
    ${metricRow("Cash after entry", `<span class="${afterCash >= 0 ? "" : "down"}">${fmt.format(afterCash)}</span>`)}
  `;
}

function coachPanel(user, metrics) {
  return `
    <section class="panel coach-panel">
      <div class="panel-head"><h2>Trade Coach</h2><span class="pill">Local rules</span></div>
      <div class="insight-list">
        ${coachInsights(user, metrics).map((item) => `<div class="insight ${item.tone}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span></div>`).join("")}
      </div>
    </section>
  `;
}

function portfolioMapPanel(user) {
  return `
    <section class="panel map-panel">
      <div class="panel-head"><h2>Portfolio Map</h2><span class="muted">Size = exposure, color = P&L</span></div>
      <div class="map-wrap"><canvas id="portfolioMapCanvas" width="900" height="420"></canvas></div>
    </section>
  `;
}

function timeMachinePanel() {
  const event = TIME_MACHINE_EVENTS[timeMachineEvent];
  return `
    <section class="panel time-panel">
      <div class="panel-head">
        <div><h2>Time Machine</h2><span class="muted">${escapeHtml(event.note)}</span></div>
        <span class="pill">${escapeHtml(event.symbol)}</span>
      </div>
      <div class="time-controls">
        <select id="timeMachineEvent">
          ${Object.entries(TIME_MACHINE_EVENTS).map(([key, item]) => `<option value="${key}" ${key === timeMachineEvent ? "selected" : ""}>${item.label}</option>`).join("")}
        </select>
        <button class="ghost" id="timeBackBtn" type="button">Back</button>
        <button class="primary" id="timePlayBtn" type="button">${timeMachineTimer ? "Pause" : "Play"}</button>
        <button class="ghost" id="timeForwardBtn" type="button">Forward</button>
      </div>
      <div class="time-wrap"><canvas id="timeMachineCanvas" width="1000" height="420"></canvas></div>
    </section>
  `;
}

function tradeReplayPanel(user) {
  const rows = user.history.slice(-6).reverse();
  return `
    <section class="panel replay-panel">
      <div class="panel-head"><h2>Trade Replay</h2><span class="muted">${rows.length} recent fills</span></div>
      <div class="stack">
        ${rows.length ? rows.map((trade) => replayRow(trade)).join("") : `<div class="empty">Your replay tape will build after a few fills.</div>`}
      </div>
    </section>
  `;
}

function achievementsPanel(user, metrics) {
  const items = achievements(user, metrics);
  return `
    <section class="panel achievements-panel">
      <div class="panel-head"><h2>Achievements</h2><span class="pill">${items.filter((item) => item.done).length}/${items.length}</span></div>
      <div class="achievement-grid">
        ${items.map((item) => `<div class="achievement ${item.done ? "done" : ""}"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span></div>`).join("")}
      </div>
    </section>
  `;
}

function commandPalette(user) {
  const commands = [
    ["search", "Search Symbol", "Jump to the chart search box"],
    ["trade", "Place Trade", `Focus the ${selectedSymbol} ticket`],
    ["risk", "Open Risk Engine", "Stress test the account"],
    ["scenario", "Build Scenario", "Preview a hypothetical trade"],
    ["time", "Time Machine", "Replay a stylized market tape"],
    ["account", "Account", `Review ${user.name}`],
  ];
  return `
    <div class="command-backdrop" data-command="close">
      <div class="command-panel" role="dialog" aria-label="Command palette">
        <div class="command-search">
          <span class="label">Command palette</span>
          <strong>Move fast without hunting through the UI</strong>
        </div>
        <div class="command-list">
          ${commands.map(([key, title, body]) => `
            <button type="button" data-command="${key}">
              <strong>${escapeHtml(title)}</strong>
              <span>${escapeHtml(body)}</span>
            </button>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function settingsPage(user) {
  return `
    <section class="settings-grid">
      <form class="panel settings-form" id="settingsForm">
        <div class="panel-head"><h2>Trading Defaults</h2><span class="muted">Saved locally</span></div>
        <label class="field">
          <span>Default symbol</span>
          <input id="defaultSymbolInput" maxlength="18" value="${escapeHtml(user.settings.defaultSymbol)}" />
        </label>
        <label class="field">
          <span>Default chart range</span>
          <select id="defaultRangeInput">
            ${Object.entries(CHART_RANGES).map(([range, item]) => `<option value="${range}" ${user.settings.defaultRange === range ? "selected" : ""}>${item.label}</option>`).join("")}
          </select>
        </label>
        <label class="field">
          <span>Quote refresh</span>
          <select id="refreshSecondsInput">
            ${[15, 30, 45, 60, 120].map((seconds) => `<option value="${seconds}" ${user.settings.refreshSeconds === seconds ? "selected" : ""}>Every ${seconds} seconds</option>`).join("")}
          </select>
        </label>
        <button class="primary wide" type="submit">Save Settings</button>
      </form>
      <div class="panel">
        <div class="panel-head"><h2>Difficulty</h2><span class="pill">${escapeHtml(user.difficulty)}</span></div>
        <div class="mode-list">
          ${Object.entries(STARTING_CASH).map(([mode, cash]) => `<div class="${mode === user.difficulty ? "active" : ""}"><strong>${mode}</strong><span>${fmt.format(cash)}</span></div>`).join("")}
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2>Data Storage</h2><span class="muted">No server account yet</span></div>
        <p class="muted">Your account, trades, settings, and leaderboard are stored in this browser with localStorage.</p>
      </div>
    </section>
  `;
}

function allPositionRows(user) {
  const rows = [];
  Object.entries(user.holdings).forEach(([symbol, position]) => {
    const last = quotes[symbol]?.price || position.avg;
    rows.push({ symbol, type: "Long", exposure: last * position.qty, pnl: (last - position.avg) * position.qty, qty: position.qty });
  });
  Object.entries(user.shorts).forEach(([symbol, position]) => {
    const last = quotes[symbol]?.price || position.avg;
    rows.push({ symbol, type: "Short", exposure: shortLiability(position, last), pnl: (position.avg - last) * position.qty, qty: position.qty });
  });
  user.options.forEach((option) => {
    const underlying = quotes[option.symbol]?.price || option.underlyingAtOpen;
    const mark = markOption(option, underlying);
    const value = mark * option.contracts * 100;
    const cost = option.premium * option.contracts * 100;
    rows.push({ symbol: `${option.symbol} ${option.type}`, type: "Option", exposure: value, pnl: value - cost, qty: option.contracts });
  });
  return rows;
}

function isCryptoSymbol(symbol) {
  return /-USD$/.test(symbol) && !["SPY", "QQQ", "DIA", "IWM"].includes(symbol);
}

function stressNetWorth(user, scenario) {
  const longValue = Object.entries(user.holdings).reduce((sum, [symbol, position]) => {
    const last = quotes[symbol]?.price || position.avg;
    const shock = isCryptoSymbol(symbol) ? scenario.crypto ?? scenario.equity : scenario.equity;
    return sum + Math.max(0, last * (1 + shock)) * position.qty;
  }, 0);
  const shortStats = Object.entries(user.shorts).reduce(
    (stats, [symbol, position]) => {
      const last = quotes[symbol]?.price || position.avg;
      const baseShock = isCryptoSymbol(symbol) ? scenario.crypto ?? scenario.equity : scenario.equity;
      const shock = scenario.short || baseShock;
      const stressed = Math.max(0.01, last * (1 + shock));
      stats.margin += position.margin || 0;
      stats.pnl += (position.avg - stressed) * position.qty;
      return stats;
    },
    { margin: 0, pnl: 0 }
  );
  const optionValue = user.options.reduce((sum, option) => {
    const underlying = quotes[option.symbol]?.price || option.underlyingAtOpen;
    const shock = isCryptoSymbol(option.symbol) ? scenario.crypto ?? scenario.equity : scenario.equity;
    const stressedUnderlying = Math.max(0.01, underlying * (1 + shock));
    const baseMark = markOption(option, underlying);
    const stressedMark = markOption(option, stressedUnderlying) * (scenario.volatility || 1);
    return sum + Math.max(0.05, stressedMark || baseMark) * option.contracts * 100;
  }, 0);
  return user.cash + longValue + optionValue + shortStats.margin + shortStats.pnl;
}

function riskScore(user, metrics) {
  if (!metrics.netWorth) return 0;
  const concentration = Math.max(0, ...allPositionRows(user).map((row) => row.exposure / Math.max(1, metrics.netWorth))) * 45;
  const leverage = Math.min(2, metrics.exposure / Math.max(1, metrics.netWorth)) * 25;
  const shorts = Object.keys(user.shorts).length * 8;
  const options = user.options.length * 5;
  return Math.min(100, Math.round(concentration + leverage + shorts + options));
}

function bestMover(user) {
  return user.watchlist
    .map((symbol) => ({ symbol, change: quotes[symbol]?.changePercent }))
    .filter((item) => Number.isFinite(item.change))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
}

function signedPct(value) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function cryptoHeat() {
  const crypto = Object.values(CRYPTO_SECTIONS)
    .flat()
    .map((symbol) => quotes[symbol]?.changePercent)
    .filter(Number.isFinite);
  if (!crypto.length) return "-";
  const avg = crypto.reduce((sum, value) => sum + value, 0) / crypto.length;
  return `${avg >= 0 ? "Hot" : "Cold"} ${signedPct(avg)}`;
}

function coachInsights(user, metrics) {
  const rows = allPositionRows(user);
  const insights = [];
  if (!rows.length) {
    return [{ title: "Rehearse first", body: "Use Scenario Builder before placing the first trade. The edge is learning before paying tuition.", tone: "warn" }];
  }
  const largest = rows.slice().sort((a, b) => b.exposure - a.exposure)[0];
  const concentration = largest && metrics.netWorth ? (largest.exposure / metrics.netWorth) * 100 : 0;
  if (concentration > 55) insights.push({ title: "Concentration warning", body: `${largest.symbol} is ${concentration.toFixed(0)}% of net worth exposure. One bad candle can steer the whole account.`, tone: "down" });
  else insights.push({ title: "Sizing is readable", body: "No single position dominates the whole account right now.", tone: "up" });
  if (Object.keys(user.shorts).length) insights.push({ title: "Short risk is asymmetric", body: "Your shorts can move against you faster than the margin line suggests. Stress the squeeze case before adding.", tone: "warn" });
  if (user.options.length) insights.push({ title: "Theta clock running", body: "Synthetic options decay with time. The trade needs both direction and timing.", tone: "warn" });
  if (user.history.length >= 8 && Math.abs(metrics.returnPct) < 1) insights.push({ title: "Activity without distance", body: "You have several fills but little return. Consider fewer, higher-conviction trades.", tone: "warn" });
  if (metrics.returnPct > 5) insights.push({ title: "Protect the lead", body: "You have a cushion. Define what would make you reduce risk before the market defines it for you.", tone: "up" });
  return insights.slice(0, 4);
}

function replayRow(trade) {
  const riskNote = trade.side.includes("option")
    ? "Defined premium risk, timing-sensitive."
    : trade.side === "short" || trade.side === "cover"
      ? "Short tape: squeeze and margin matter."
      : trade.total > 2500
        ? "Large allocation. Review sizing."
        : "Clean small-lot fill.";
  return `
    <div class="replay-row">
      <div><strong>${escapeHtml(trade.side.toUpperCase())} ${escapeHtml(trade.symbol)}</strong><span class="muted">${new Date(trade.time).toLocaleString()}</span></div>
      <div class="right"><strong>${fmt.format(trade.total)}</strong><span class="muted">${riskNote}</span></div>
    </div>
  `;
}

function achievements(user, metrics) {
  const risk = riskScore(user, metrics);
  return [
    { title: "First Fill", body: "Place a paper trade.", done: user.history.length > 0 },
    { title: "Risk Manager", body: "Keep the lab risk score under 45.", done: positionsCount(user) > 0 && risk < 45 },
    { title: "Capital Defender", body: "Stay above starting cash.", done: metrics.netWorth >= metrics.start },
    { title: "Scenario Thinker", body: "Open the lab and preview a trade.", done: true },
    { title: "Diversifier", body: "Hold three or more open positions.", done: positionsCount(user) >= 3 },
    { title: "Patient Operator", body: "Keep fewer fills than watchlist names.", done: user.history.length > 0 && user.history.length < user.watchlist.length },
  ];
}

function metricRow(label, value) {
  return `<div><span class="muted">${label}</span><strong>${value}</strong></div>`;
}

function stat(label, value, tone = "") {
  return `<div class="stat"><span class="label">${label}</span><span class="value ${tone}">${value}</span></div>`;
}

function quoteSubhead(symbol) {
  const quote = quotes[symbol];
  if (!quote) return `${escapeHtml(symbol)} quote loading`;
  const source = quote.source === "fallback" ? "backup pricing" : "live market data";
  return `${escapeHtml(quote.name || symbol)} · ${source}`;
}

function assetCard(symbol) {
  const quote = quotes[symbol];
  const change = quote ? quote.changePercent : 0;
  const tone = change >= 0 ? "up" : "down";
  return `
    <div class="asset-card ${symbol === selectedSymbol ? "active" : ""}">
      <button class="asset-select" data-symbol="${escapeHtml(symbol)}" type="button">
        <div class="asset-top">
          <span class="symbol">${escapeHtml(symbol)}</span>
          <span class="price">${quote ? fmt.format(quote.price) : "Loading"}</span>
        </div>
        <div class="asset-meta">
          <span class="${tone}">${quote ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "..."}</span>
          <span>${quote ? escapeHtml(quote.marketState || "market") : "quote"}</span>
        </div>
      </button>
      <button class="remove-watch" data-remove="${escapeHtml(symbol)}" title="Remove from watchlist" type="button">x</button>
    </div>
  `;
}

function tradeError(message) {
  notify(message);
  return false;
}

function tradeSuccess(user, side, symbol, qty, price, total) {
  lastFill = { side, symbol, qty, price, total, time: Date.now() };
  record(user, side, symbol, qty, price, total);
  return true;
}

function positionValueForAction(action, symbol) {
  const user = currentUser();
  const quote = quotes[symbol];
  if (!quote) return 0;
  if (action === "sell") return (user.holdings[symbol]?.qty || 0) * quote.price;
  if (action === "short") return user.cash * 2;
  if (action === "option") return user.cash;
  if (action === "buy" && user.shorts[symbol]) {
    return Math.min(user.shorts[symbol].qty * quote.price, user.cash + user.shorts[symbol].margin);
  }
  return user.cash;
}

function selectedPositionSnapshot(user, symbol) {
  if (user.holdings[symbol]) {
    const position = user.holdings[symbol];
    const last = quotes[symbol]?.price || position.avg;
    return {
      symbol,
      type: "Long",
      qty: position.qty,
      avg: position.avg,
      value: position.qty * last,
      pnl: (last - position.avg) * position.qty,
    };
  }
  if (user.shorts[symbol]) {
    const position = user.shorts[symbol];
    const last = quotes[symbol]?.price || position.avg;
    return {
      symbol,
      type: "Short",
      qty: position.qty,
      avg: position.avg,
      value: shortAccountValue(position, last),
      pnl: (position.avg - last) * position.qty,
    };
  }
  const option = user.options.find((item) => item.symbol === symbol);
  if (option) {
    const underlying = quotes[option.symbol]?.price || option.underlyingAtOpen;
    const mark = markOption(option, underlying);
    const value = mark * option.contracts * 100;
    const cost = option.premium * option.contracts * 100;
    return {
      symbol,
      type: `${option.type.toUpperCase()} option`,
      qty: option.contracts,
      avg: option.premium,
      value,
      pnl: value - cost,
    };
  }
  return null;
}

function positionPanel(position) {
  const tone = position.pnl >= 0 ? "up" : "down";
  return `
    <div class="context-panel" id="positionContext">
      <div class="panel-head"><h2>Position</h2><span class="pill">${escapeHtml(position.type)}</span></div>
      <div class="position-summary">
        <strong>${escapeHtml(position.symbol)}</strong>
        <span class="${tone}">${position.pnl >= 0 ? "+" : ""}${fmt.format(position.pnl)}</span>
      </div>
      <div class="metric-list compact-list">
        ${metricRow("Quantity", qtyFmt.format(position.qty))}
        ${metricRow("Average cost", fmt.format(position.avg))}
        ${metricRow("Market value", fmt.format(position.value))}
      </div>
      <div class="context-actions">
        <button class="ghost" data-side="sell" type="button">Sell</button>
        <button class="ghost" data-side="short" type="button">Short</button>
      </div>
    </div>
  `;
}

function marketContextPanel(symbol, quote) {
  return `
    <div class="context-panel" id="marketContext">
      <div class="panel-head"><h2>Market Context</h2><span class="pill">${escapeHtml(marketStateLabel(quote))}</span></div>
      <div class="metric-list compact-list">
        ${metricRow("Selected", escapeHtml(symbol))}
        ${metricRow("Name", quote ? escapeHtml(quote.name || symbol) : "Loading")}
        ${metricRow("Previous close", quote?.previousClose ? fmt.format(quote.previousClose) : "-")}
        ${metricRow("Source", quote ? escapeHtml(quote.source || "market") : "-")}
      </div>
    </div>
  `;
}

function marketStateLabel(quote) {
  const state = String(quote?.marketState || "").toUpperCase();
  if (["REGULAR", "OPEN"].includes(state)) return "Live";
  if (["PRE", "PREPRE", "POST", "POSTPOST"].includes(state)) return "After hours";
  if (state === "CLOSED") return "Closed";
  return quote ? "Market" : "Loading";
}

function applyShortCover(user, symbol, qty, price) {
  const short = user.shorts[symbol];
  if (!short) return { covered: 0, ok: true };
  const coverQty = Math.min(qty, short.qty);
  const cashDelta = realizedShortCashDelta(short, coverQty, price);
  const coverCost = coverQty * price;
  if (user.cash + cashDelta < 0) return { covered: 0, ok: tradeError("Not enough cash to cover that short.") };
  user.cash += cashDelta;
  short.qty -= coverQty;
  short.margin -= short.margin * (coverQty / (short.qty + coverQty));
  if (short.qty <= 0.000001) delete user.shorts[symbol];
  lastFill = { side: "cover", symbol, qty: coverQty, price, total: coverCost, time: Date.now() };
  record(user, "cover", symbol, coverQty, price, coverCost);
  return { covered: coverQty, ok: true };
}

function tradeTicket() {
  const quote = quotes[selectedSymbol];
  const price = quote?.price || 0;
  const optionPremium = estimateOptionPremium(price);
  const change = quote?.changePercent || 0;
  const tone = change >= 0 ? "up" : "down";
  return `
    <form class="trade-ticket side-${tradeSide}" id="tradeForm">
      <div class="ticket-quote">
        <div>
          <span class="label">Selected</span>
          <strong>${escapeHtml(selectedSymbol)}</strong>
        </div>
        <div class="right">
          <strong>${price ? fmt.format(price) : "Loading"}</strong>
          <span class="${tone}">${quote ? `${change >= 0 ? "+" : ""}${change.toFixed(2)}%` : "-"}</span>
        </div>
      </div>
      <div class="tabs">
        ${["buy", "sell", "short", "option"].map((side) => `<button type="button" data-side="${side}" class="${tradeSide === side ? "active" : ""}">${side.toUpperCase()}</button>`).join("")}
      </div>
      <div class="row-2">
        <label class="field"><span>${tradeSide === "option" ? "Contracts" : "Shares / units"}</span><input id="qtyInput" type="number" min="0.0001" step="0.0001" value="1" /></label>
        <label class="field">
          <span>${tradeSide === "option" ? "Contract" : "Symbol"}</span>
          <select id="optionType" ${tradeSide === "option" ? "" : "disabled"}>
            <option value="call">Call</option>
            <option value="put">Put</option>
          </select>
        </label>
      </div>
      <div class="quick-size">
        ${[0.25, 0.5, 1].map((pct) => `<button type="button" data-size="${pct}">${Math.round(pct * 100)}%</button>`).join("")}
        <button type="button" data-size="max">Max</button>
      </div>
      <div class="ticket-preview">
        <div><span class="muted">Last price</span><strong>${price ? fmt.format(price) : "Loading"}</strong></div>
        <div><span class="muted">Option premium</span><strong>${price ? fmt.format(optionPremium) : "Loading"}</strong></div>
        <div><span class="muted">Est. order</span><strong id="orderEstimate">-</strong></div>
        <div><span class="muted">Buying power</span><strong>${fmt.format(currentUser().cash)}</strong></div>
      </div>
      <button class="primary wide order-button" type="submit" ${marketDataStatus === "stale" ? "disabled" : ""}>${marketDataStatus === "stale" ? "Refresh Required" : `Place ${tradeSide.toUpperCase()}`}</button>
    </form>
  `;
}

function portfolioRows(user) {
  const stockRows = Object.entries(user.holdings).map(([symbol, position]) => {
    const quote = quotes[symbol];
    const last = quote?.price || position.avg;
    const value = last * position.qty;
    const pnl = (last - position.avg) * position.qty;
    return positionRow({ symbol, label: "Long", qty: position.qty, avg: position.avg, value, pnl, action: "sell", button: "Sell All" });
  });
  const shortRows = Object.entries(user.shorts).map(([symbol, position]) => {
    const quote = quotes[symbol];
    const last = quote?.price || position.avg;
    const pnl = (position.avg - last) * position.qty;
    const value = shortAccountValue(position, last);
    return positionRow({ symbol, label: "Short", qty: position.qty, avg: position.avg, value, pnl, action: "cover", button: "Cover" });
  });
  const optionRows = user.options.map((option, index) => {
    const underlying = quotes[option.symbol]?.price || option.underlyingAtOpen;
    const mark = markOption(option, underlying);
    const value = mark * option.contracts * 100;
    const cost = option.premium * option.contracts * 100;
    const daysLeft = Math.max(0, Math.ceil((option.expiresAt - Date.now()) / 86400000));
    return positionRow({
      symbol: `${option.symbol} ${option.type.toUpperCase()} ${option.strike}`,
      label: `${daysLeft}d`,
      qty: option.contracts,
      avg: option.premium,
      value,
      pnl: value - cost,
      action: "close-option",
      button: "Close",
      index,
    });
  });
  return [...stockRows, ...shortRows, ...optionRows].join("");
}

function positionRow({ symbol, label, qty, avg, value, pnl, action, button, index = "" }) {
  const tone = pnl >= 0 ? "up" : "down";
  return `
    <div class="holding-row">
      <div>
        <div class="holding-top"><strong>${escapeHtml(symbol)}</strong><span class="pill">${escapeHtml(label)}</span></div>
        <span class="muted">${qtyFmt.format(qty)} @ ${fmt.format(avg)}</span>
      </div>
      <div class="position-numbers">
        <strong>${fmt.format(value)}</strong>
        <span class="${tone}">${pnl >= 0 ? "+" : ""}${fmt.format(pnl)}</span>
        <button class="ghost position-action" data-action="${action}" data-symbol="${escapeHtml(symbol.split(" ")[0])}" data-index="${index}">${button}</button>
      </div>
    </div>
  `;
}

function leaderboardRows() {
  return Object.values(db.users)
    .map((user) => ({ user, metrics: getMetrics(user) }))
    .sort((a, b) => b.metrics.netWorth - a.metrics.netWorth)
    .slice(0, 8)
    .map((entry, index) => {
      const tone = entry.metrics.returnPct >= 0 ? "up" : "down";
      return `
        <div class="leader-row">
          <div><strong>#${index + 1} ${escapeHtml(entry.user.name)}</strong><br><span class="muted">${entry.user.difficulty}</span></div>
          <div class="right"><strong>${fmt.format(entry.metrics.netWorth)}</strong><br><span class="${tone}">${entry.metrics.returnPct.toFixed(2)}%</span></div>
        </div>
      `;
    })
    .join("");
}

function historyRows(user) {
  return user.history
    .slice()
    .reverse()
    .slice(0, 16)
    .map((trade) => `
      <div class="history-row">
        <div><strong>${escapeHtml(trade.side.toUpperCase())} ${escapeHtml(trade.symbol)}</strong><br><span class="muted">${new Date(trade.time).toLocaleString()}</span></div>
        <div class="right"><strong>${fmt.format(trade.total)}</strong><br><span class="muted">${qtyFmt.format(trade.qty)} @ ${fmt.format(trade.price)}</span></div>
      </div>
    `)
    .join("");
}

function bindDashboard() {
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.addEventListener("click", () => {
      const nextPage = button.dataset.page;
      if (nextPage !== "lab") stopTimeMachine();
      activePage = nextPage;
      renderDashboard();
      if (activePage === "dashboard") {
        refreshQuotes();
        refreshChart(selectedSymbol);
      }
      if (activePage === "market") refreshQuotes(true);
      if (activePage === "crypto") refreshQuotes(true);
      if (activePage === "montecarlo") runMonteCarlo();
      if (activePage === "lab") refreshQuotes(true);
    });
  });
  document.querySelector("#sidebarToggle")?.addEventListener("click", () => {
    sidebarCollapsed = !sidebarCollapsed;
    renderDashboard();
    if (activePage === "dashboard") drawChart();
    if (activePage === "montecarlo") runMonteCarlo();
  });
  document.querySelector("#logoutBtn")?.addEventListener("click", () => {
    if (session) sessionStorage.removeItem(`stock-simulator-auth:${session}`);
    session = null;
    saveDb();
    app();
  });
  document.querySelector("#resetBtn")?.addEventListener("click", () => {
    const user = currentUser();
    if (!confirm(`Reset ${user.name}'s account?`)) return;
    const auth = user.pinHash
      ? { pinHash: user.pinHash, pinSalt: user.pinSalt, pinKdf: user.pinKdf, pinIterations: user.pinIterations }
      : { pin: user.pin, needsPasscodeUpgrade: true };
    db.users[user.name] = makeUser(user.name, auth, user.difficulty);
    selectedSymbol = db.users[user.name].settings.defaultSymbol;
    chartRange = db.users[user.name].settings.defaultRange;
    tradeSide = "buy";
    chart = [];
    saveDb();
    notify("Account reset.");
    app();
  });
  document.querySelector("#liveBtn")?.addEventListener("click", () => {
    refreshQuotes(true);
    if (activePage === "dashboard") refreshChart(selectedSymbol);
  });
  document.querySelector("#newOrderBtn")?.addEventListener("click", focusTradeTicket);
  document.querySelector("#firstTradeBtn")?.addEventListener("click", focusTradeTicket);
  document.querySelector("#exportBtn")?.addEventListener("click", exportAccountData);
  document.querySelector("#settingsForm")?.addEventListener("submit", saveSettings);
  document.querySelector("#monteForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    runMonteCarlo();
  });
  document.querySelector("#scenarioForm")?.addEventListener("input", handleScenarioInput);
  document.querySelector("#timeMachineEvent")?.addEventListener("change", (event) => {
    timeMachineEvent = event.target.value;
    timeMachineStep = 18;
    stopTimeMachine();
    renderDashboard();
  });
  document.querySelector("#timeBackBtn")?.addEventListener("click", () => {
    timeMachineStep = Math.max(1, timeMachineStep - 6);
    drawTimeMachine();
  });
  document.querySelector("#timeForwardBtn")?.addEventListener("click", () => {
    timeMachineStep = Math.min(72, timeMachineStep + 6);
    drawTimeMachine();
  });
  document.querySelector("#timePlayBtn")?.addEventListener("click", toggleTimeMachine);
  document.querySelectorAll("[data-command]").forEach((button) => {
    button.addEventListener("click", () => runCommand(button.dataset.command));
  });
  document.querySelectorAll("[data-strip-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSymbol = button.dataset.stripSymbol;
      activePage = "dashboard";
      renderDashboard();
      refreshChart(selectedSymbol);
    });
  });
  document.querySelectorAll("[data-market-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      selectedSymbol = button.dataset.marketSymbol;
      activePage = "dashboard";
      if (!currentUser().watchlist.includes(selectedSymbol)) currentUser().watchlist.unshift(selectedSymbol);
      saveDb();
      renderDashboard();
      refreshQuotes(true);
      refreshChart(selectedSymbol);
    });
  });
  document.querySelectorAll("[data-watch-symbol]").forEach((button) => {
    button.addEventListener("click", () => {
      const symbol = button.dataset.watchSymbol;
      const user = currentUser();
      if (!user.watchlist.includes(symbol)) user.watchlist.unshift(symbol);
      saveDb();
      notify(`${symbol} added to watchlist.`);
      renderDashboard();
      refreshQuotes(true);
    });
  });
  document.querySelectorAll(".asset-select").forEach((card) => {
    card.addEventListener("click", () => {
      selectedSymbol = card.dataset.symbol;
      renderDashboard();
      refreshChart(selectedSymbol);
    });
  });
  document.querySelectorAll(".remove-watch").forEach((button) => {
    button.addEventListener("click", () => removeFromWatchlist(button.dataset.remove));
  });
  document.querySelector("#searchForm")?.addEventListener("submit", (event) => {
    event.preventDefault();
    addSymbol(document.querySelector("#symbolInput").value);
  });
  document.querySelectorAll(".range-tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      chartRange = button.dataset.range;
      renderDashboard();
      refreshChart(selectedSymbol);
    });
  });
  document.querySelectorAll(".tabs button").forEach((button) => {
    button.addEventListener("click", () => {
      tradeSide = button.dataset.side;
      renderDashboard();
    });
  });
  document.querySelector("#qtyInput")?.addEventListener("input", updateOrderPreview);
  document.querySelector("#optionType")?.addEventListener("change", updateOrderPreview);
  document.querySelectorAll(".quick-size button").forEach((button) => {
    button.addEventListener("click", () => setQuickSize(button.dataset.size));
  });
  document.querySelector("#tradeForm")?.addEventListener("submit", placeTrade);
  const chartCanvas = document.querySelector("#chartCanvas");
  chartCanvas?.addEventListener("mousemove", handleChartHover);
  chartCanvas?.addEventListener("mouseleave", () => {
    chartHoverRatio = null;
    document.querySelector("#chartHoverChip")?.classList.remove("show");
    drawChart();
  });
  document.querySelectorAll(".position-action").forEach((button) => {
    button.addEventListener("click", () => handlePositionAction(button));
  });
}

function handleScenarioInput() {
  scenarioSymbol = normalizeSymbol(document.querySelector("#scenarioSymbolInput")?.value) || selectedSymbol;
  scenarioSide = document.querySelector("#scenarioSideInput")?.value || "buy";
  scenarioQty = Number(document.querySelector("#scenarioQtyInput")?.value || 0);
  scenarioMove = Number(document.querySelector("#scenarioMoveInput")?.value || 0);
  updateScenarioPreview();
}

function updateScenarioPreview() {
  const output = document.querySelector("#scenarioOutput");
  if (!output) return;
  const symbol = normalizeSymbol(scenarioSymbol) || selectedSymbol;
  output.innerHTML = scenarioPreview(currentUser(), symbol, quotes[symbol]);
}

function toggleTimeMachine() {
  if (timeMachineTimer) {
    stopTimeMachine();
    renderDashboard();
    return;
  }
  timeMachineTimer = setInterval(() => {
    timeMachineStep = timeMachineStep >= 72 ? 1 : timeMachineStep + 1;
    drawTimeMachine();
  }, 360);
  renderDashboard();
}

function stopTimeMachine() {
  clearInterval(timeMachineTimer);
  timeMachineTimer = null;
}

function runCommand(command) {
  commandPaletteOpen = false;
  if (command === "search") {
    activePage = "dashboard";
    renderDashboard();
    document.querySelector("#symbolInput")?.focus();
    return;
  }
  if (command === "trade") {
    activePage = "dashboard";
    renderDashboard();
    focusTradeTicket();
    return;
  }
  if (command === "risk") activePage = "lab";
  if (command === "time") {
    activePage = "lab";
    timeMachineStep = 18;
  }
  if (command === "scenario") activePage = "lab";
  if (command === "account") activePage = "account";
  renderDashboard();
}

function focusTradeTicket() {
  const ticket = document.querySelector("#trade");
  const qty = document.querySelector("#qtyInput");
  ticket?.classList.remove("ticket-pulse");
  requestAnimationFrame(() => ticket?.classList.add("ticket-pulse"));
  qty?.focus();
  qty?.select();
}

function handleChartHover(event) {
  const canvas = event.currentTarget;
  const rect = canvas.getBoundingClientRect();
  chartHoverRatio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  drawChart();
}

function addSymbol(value) {
  const symbol = normalizeSymbol(value);
  if (!symbol) return;
  const user = currentUser();
  if (!user.watchlist.includes(symbol)) user.watchlist.unshift(symbol);
  selectedSymbol = symbol;
  saveDb();
  renderDashboard();
  refreshQuotes(true);
  refreshChart(symbol);
}

function removeFromWatchlist(symbol) {
  const user = currentUser();
  if (user.watchlist.length <= 1) return notify("Keep at least one ticker on the watchlist.");
  user.watchlist = user.watchlist.filter((item) => item !== symbol);
  if (selectedSymbol === symbol) selectedSymbol = user.watchlist[0];
  saveDb();
  renderDashboard();
  refreshChart(selectedSymbol);
}

function exportAccountData() {
  const user = currentUser();
  const { pin, pinHash, pinSalt, pinKdf, pinIterations, needsPasscodeUpgrade, ...safeUser } = user;
  const payload = {
    exportedAt: new Date().toISOString(),
    user: safeUser,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFilePart(user.name)}-stock-simulator-account.json`;
  link.click();
  URL.revokeObjectURL(url);
  notify("Account export created.");
}

function safeFilePart(value) {
  return normalizeAccountName(value) || "account";
}

function saveSettings(event) {
  event.preventDefault();
  const user = currentUser();
  const defaultSymbol = normalizeSymbol(document.querySelector("#defaultSymbolInput").value) || "AAPL";
  const refreshSeconds = Number(document.querySelector("#refreshSecondsInput").value);
  const requestedRange = document.querySelector("#defaultRangeInput").value;
  const defaultRange = CHART_RANGES[requestedRange] ? requestedRange : "1mo";
  user.settings = {
    defaultSymbol,
    refreshSeconds,
    defaultRange,
  };
  if (!user.watchlist.includes(defaultSymbol)) user.watchlist.unshift(defaultSymbol);
  selectedSymbol = defaultSymbol;
  chartRange = defaultRange;
  saveDb();
  scheduleRefresh();
  notify("Settings saved.");
  renderDashboard();
}

async function refreshQuotes(force = false) {
  const user = currentUser();
  if (!user) return;
  const marketSymbols = activePage === "market" ? Object.values(MARKET_SECTIONS).flat() : [];
  const cryptoSymbols = activePage === "crypto" ? Object.values(CRYPTO_SECTIONS).flat() : [];
  const symbols = [...new Set([...user.watchlist, ...marketSymbols, ...cryptoSymbols, ...Object.keys(user.holdings), ...Object.keys(user.shorts), ...user.options.map((item) => item.symbol)])];
  if (!force && symbols.every((symbol) => quotes[symbol])) return;
  try {
    const data = await fetchQuotes(symbols);
    const failedSymbols = [];
    data.quotes.forEach((quote) => {
      if (quote.error) {
        failedSymbols.push(quote.symbol);
        delete quotes[quote.symbol];
        return;
      }
      if (quotes[quote.symbol]?.price) previousPrices[quote.symbol] = quotes[quote.symbol].price;
      quotes[quote.symbol] = quote;
    });
    let shouldReloadSelectedChart = false;
    if (failedSymbols.length) {
      const user = currentUser();
      user.watchlist = user.watchlist.filter((symbol) => !failedSymbols.includes(symbol));
      if (failedSymbols.includes(selectedSymbol)) {
        selectedSymbol = user.watchlist[0] || user.settings.defaultSymbol || "AAPL";
        shouldReloadSelectedChart = true;
      }
      saveDb();
      notify(`Could not find: ${failedSymbols.join(", ")}`);
    }
    lastRefresh = Date.now();
    marketDataStatus = "live";
    if (!isEditingForm() && ["dashboard", "market", "crypto", "account", "lab"].includes(activePage)) {
      renderDashboard();
    }
    if (shouldReloadSelectedChart && activePage === "dashboard") refreshChart(selectedSymbol);
  } catch {
    marketDataStatus = "stale";
    if (!isEditingForm() && activePage === "dashboard") renderDashboard();
    notify("Market data is unavailable right now.");
  }
}

async function refreshChart(symbol) {
  const requestId = ++chartRequestId;
  try {
    const interval = CHART_RANGES[chartRange].interval;
    const data = await fetchChart(symbol, chartRange, interval);
    if (requestId !== chartRequestId || symbol !== selectedSymbol) return;
    chart = data.points || [];
    if (data.price) quotes[data.symbol] = { ...data, points: undefined };
    animateChart();
  } catch {
    if (requestId !== chartRequestId || symbol !== selectedSymbol) return;
    chart = [];
    drawChart();
  }
}

function animateChart() {
  cancelAnimationFrame(chartAnimationFrame);
  const started = performance.now();
  const duration = 600;
  const frame = (now) => {
    const progress = Math.min(1, (now - started) / duration);
    drawChart(1 - Math.pow(1 - progress, 3));
    if (progress < 1) chartAnimationFrame = requestAnimationFrame(frame);
  };
  chartAnimationFrame = requestAnimationFrame(frame);
}

function drawSparklines() {
  document.querySelectorAll("[data-spark-symbol]").forEach((canvas) => {
    const symbol = canvas.dataset.sparkSymbol;
    const ctx = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const quote = quotes[symbol];
    const points = symbol === selectedSymbol && chart.length ? chart : syntheticSparkline(symbol, quote?.price || 1);
    const values = points.map((point) => point.close || point.price || 0).filter(Number.isFinite);
    if (!values.length) return;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const spread = max - min || 1;
    const rising = values.at(-1) >= values[0];
    ctx.clearRect(0, 0, width, height);
    const coords = values.map((value, index) => ({
      x: (index / Math.max(1, values.length - 1)) * width,
      y: height - 6 - ((value - min) / spread) * (height - 12),
    }));
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, rising ? "rgba(136, 184, 158, 0.16)" : "rgba(184, 126, 139, 0.16)");
    gradient.addColorStop(1, "rgba(255, 255, 255, 0)");
    ctx.beginPath();
    coords.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.beginPath();
    coords.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
    ctx.strokeStyle = rising ? "rgba(136, 184, 158, 0.58)" : "rgba(184, 126, 139, 0.58)";
    ctx.lineWidth = 1.25;
    ctx.stroke();
  });
}

function syntheticSparkline(symbol, price) {
  let seed = 0;
  for (const char of symbol) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  return Array.from({ length: 24 }, (_, index) => ({
    close: price * (1 + Math.sin(index / 3 + seed) * 0.006 + (index - 12) * 0.0005),
  }));
}

function drawChart(progress = 1) {
  const canvas = document.querySelector("#chartCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#05090e";
  ctx.fillRect(0, 0, width, height);
  const points = chart.length ? chart : Array.from({ length: 2 }, (_, index) => ({ close: quotes[selectedSymbol]?.price || 1, time: index }));
  const values = points.map((point) => point.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = 34;
  const spread = max - min || 1;
  const rising = values.at(-1) >= values[0];
  const lineColor = rising ? "#88b89e" : "#b87e8b";

  ctx.strokeStyle = "rgba(197, 212, 232, 0.06)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const coords = points.map((point, index) => ({
    x: pad + (index / Math.max(1, points.length - 1)) * (width - pad * 2),
    y: height - pad - ((point.close - min) / spread) * (height - pad * 2),
  }));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width * progress, height);
  ctx.clip();
  ctx.beginPath();
  coords.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.lineTo(coords.at(-1).x, height - pad);
  ctx.lineTo(coords[0].x, height - pad);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, pad, 0, height);
  gradient.addColorStop(0, rising ? "rgba(136, 184, 158, 0.16)" : "rgba(184, 126, 139, 0.16)");
  gradient.addColorStop(1, "rgba(5, 9, 14, 0)");
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  coords.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  ctx.restore();
  ctx.fillStyle = "#f7f9fc";
  ctx.font = '600 22px "Geist", "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(`${selectedSymbol} ${fmt.format(values.at(-1) || 0)}`, 22, 34);
  ctx.fillStyle = rising ? "#88b89e" : "#b87e8b";
  ctx.font = '600 15px "Geist Mono", "SF Mono", "Roboto Mono", ui-monospace, monospace';
  const pct = values[0] ? ((values.at(-1) - values[0]) / values[0]) * 100 : 0;
  ctx.fillText(`${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% ${CHART_RANGES[chartRange].label}`, 22, 58);
  drawFillMarkers(ctx, coords, values, width, height, pad);
  if (chartHoverRatio !== null && coords.length) {
    const index = Math.min(coords.length - 1, Math.max(0, Math.round(chartHoverRatio * (coords.length - 1))));
    const point = coords[index];
    ctx.strokeStyle = "rgba(169, 231, 255, 0.28)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(point.x, pad);
    ctx.lineTo(point.x, height - pad);
    ctx.stroke();
    ctx.fillStyle = "rgba(169, 231, 255, 0.9)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
    ctx.fill();
    const chip = document.querySelector("#chartHoverChip");
    if (chip) {
      const pointData = points[index];
      const first = values[0] || values[index];
      const rangePct = first ? ((values[index] - first) / first) * 100 : 0;
      chip.replaceChildren();
      const price = document.createElement("strong");
      price.textContent = fmt.format(values[index]);
      const detail = document.createElement("span");
      detail.textContent = `${rangePct >= 0 ? "+" : ""}${rangePct.toFixed(2)}% · ${formatChartTime(pointData?.time)}`;
      chip.append(price, detail);
      chip.classList.add("show");
      chip.style.left = `${Math.min(82, Math.max(8, (point.x / width) * 100))}%`;
      chip.style.top = `${Math.min(78, Math.max(10, (point.y / height) * 100))}%`;
    }
  }
}

function drawFillMarkers(ctx, coords, values, width, height, pad) {
  const user = currentUser();
  if (!user || !coords.length) return;
  const fills = user.history.filter((item) => item.symbol === selectedSymbol).slice(-8);
  fills.forEach((fill, index) => {
    const pointIndex = Math.min(coords.length - 1, Math.max(0, Math.round((index + 1) * (coords.length / (fills.length + 1)))));
    const point = coords[pointIndex];
    ctx.fillStyle = fill.side.includes("sell") || fill.side.includes("cover") ? "rgba(184, 126, 139, 0.95)" : "rgba(169, 231, 255, 0.95)";
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4.5, 0, Math.PI * 2);
    ctx.fill();
  });
}

function drawPortfolioMap(user) {
  const canvas = document.querySelector("#portfolioMapCanvas");
  if (!canvas || !user) return;
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#05090e";
  ctx.fillRect(0, 0, width, height);
  const rows = allPositionRows(user).sort((a, b) => b.exposure - a.exposure).slice(0, 10);
  if (!rows.length) {
    ctx.fillStyle = "#8d99a8";
    ctx.font = '700 24px "Geist", sans-serif';
    ctx.fillText("Open positions become a live exposure map.", 32, 62);
    return;
  }
  const maxExposure = Math.max(...rows.map((row) => row.exposure), 1);
  const columns = Math.ceil(Math.sqrt(rows.length));
  const cellW = width / columns;
  const cellH = height / Math.ceil(rows.length / columns);
  rows.forEach((row, index) => {
    const col = index % columns;
    const line = Math.floor(index / columns);
    const cx = col * cellW + cellW / 2;
    const cy = line * cellH + cellH / 2;
    const radius = Math.max(28, Math.min(cellW, cellH) * 0.18 + (row.exposure / maxExposure) * Math.min(cellW, cellH) * 0.2);
    const gradient = ctx.createRadialGradient(cx - radius * 0.25, cy - radius * 0.3, radius * 0.1, cx, cy, radius);
    gradient.addColorStop(0, row.pnl >= 0 ? "rgba(114,224,166,0.92)" : "rgba(255,109,130,0.92)");
    gradient.addColorStop(1, row.type === "Short" ? "rgba(185,200,255,0.32)" : "rgba(169,231,255,0.2)");
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = row.type === "Option" ? "rgba(216,229,242,0.72)" : "rgba(255,255,255,0.2)";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = "#f7f9fc";
    ctx.textAlign = "center";
    ctx.font = '760 18px "Geist Mono", monospace';
    ctx.fillText(row.symbol.split(" ")[0], cx, cy - 2);
    ctx.fillStyle = row.pnl >= 0 ? "#72e0a6" : "#ff6d82";
    ctx.font = '700 13px "Geist", sans-serif';
    ctx.fillText(`${row.pnl >= 0 ? "+" : ""}${fmt.format(row.pnl)}`, cx, cy + 18);
  });
  ctx.textAlign = "left";
}

function drawTimeMachine() {
  const canvas = document.querySelector("#timeMachineCanvas");
  if (!canvas) return;
  const event = TIME_MACHINE_EVENTS[timeMachineEvent];
  const points = timeMachinePoints(event);
  const visible = points.slice(0, Math.max(2, timeMachineStep));
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const pad = 38;
  const values = points.map((point) => point.close);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#05090e";
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(197,212,232,0.08)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  const coords = visible.map((point, index) => ({
    x: pad + (index / Math.max(1, points.length - 1)) * (width - pad * 2),
    y: height - pad - ((point.close - min) / spread) * (height - pad * 2),
  }));
  ctx.beginPath();
  coords.forEach((point, index) => (index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)));
  ctx.strokeStyle = visible.at(-1).close >= visible[0].close ? "#72e0a6" : "#ff6d82";
  ctx.lineWidth = 2.4;
  ctx.stroke();
  ctx.fillStyle = "#f7f9fc";
  ctx.font = '700 24px "Geist", sans-serif';
  ctx.fillText(`${event.label}: ${event.symbol}`, 28, 36);
  ctx.fillStyle = "#8d99a8";
  ctx.font = '700 14px "Geist Mono", monospace';
  const first = visible[0].close;
  const last = visible.at(-1).close;
  ctx.fillText(`Tape ${timeMachineStep}/72  ${fmt.format(last)}  ${signedPct(((last - first) / first) * 100)}`, 28, 60);
  const cursor = coords.at(-1);
  if (cursor) {
    ctx.fillStyle = "#dff5ff";
    ctx.beginPath();
    ctx.arc(cursor.x, cursor.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function timeMachinePoints(event) {
  const points = [];
  let price = event.start;
  for (let index = 0; index < 72; index += 1) {
    const wave = Math.sin(index * 0.65 + event.start) * event.volatility;
    const jolt = Math.cos(index * 1.7) * event.volatility * 0.42;
    price = Math.max(0.01, price * event.drift * (1 + wave + jolt));
    points.push({ close: price });
  }
  return points;
}

function formatChartTime(time) {
  if (!time) return "range";
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return "range";
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function runMonteCarlo() {
  const canvas = document.querySelector("#monteCanvas");
  const statsNode = document.querySelector("#mcStats");
  if (!canvas || !statsNode) return;
  const start = Math.max(1, Number(document.querySelector("#mcStart")?.value || 10000));
  const years = Math.max(1, Math.min(40, Number(document.querySelector("#mcYears")?.value || 10)));
  const annualReturn = Number(document.querySelector("#mcReturn")?.value || 8) / 100;
  const volatility = Math.max(0, Number(document.querySelector("#mcVolatility")?.value || 18) / 100);
  const contribution = Math.max(0, Number(document.querySelector("#mcContribution")?.value || 0));
  const months = years * 12;
  const paths = 1000;
  const finals = [];
  const samplePaths = [];

  for (let path = 0; path < paths; path++) {
    let value = start;
    const series = [value];
    for (let month = 1; month <= months; month++) {
      const shock = randomNormal();
      const monthlyReturn = annualReturn / 12 + (volatility / Math.sqrt(12)) * shock;
      value = Math.max(0, value * (1 + monthlyReturn) + contribution);
      if (path < 36 && month % Math.max(1, Math.round(months / 60)) === 0) series.push(value);
    }
    finals.push(value);
    if (path < 36) samplePaths.push(series);
  }

  finals.sort((a, b) => a - b);
  const median = percentile(finals, 0.5);
  const p10 = percentile(finals, 0.1);
  const p90 = percentile(finals, 0.9);
  const lossRisk = (finals.filter((value) => value < start).length / finals.length) * 100;
  statsNode.innerHTML = [
    stat("Median", fmt.format(median)),
    stat("Best 10%", fmt.format(p90), "up"),
    stat("Worst 10%", fmt.format(p10), p10 >= start ? "up" : "down"),
    stat("Loss Risk", `${lossRisk.toFixed(1)}%`, lossRisk > 35 ? "warn" : ""),
  ].join("");
  drawMonteCarlo(canvas, samplePaths, finals);
}

function drawMonteCarlo(canvas, samplePaths, finals) {
  const ctx = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0f151d";
  ctx.fillRect(0, 0, width, height);
  const allValues = samplePaths.flat().concat(finals);
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const pad = 34;
  const spread = max - min || 1;
  ctx.strokeStyle = "#263241";
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    const y = (height / 5) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  samplePaths.forEach((series, index) => {
    ctx.strokeStyle = index % 3 === 0 ? "rgba(85, 199, 255, 0.34)" : "rgba(181, 167, 255, 0.18)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    series.forEach((value, pointIndex) => {
      const x = pad + (pointIndex / Math.max(1, series.length - 1)) * (width - pad * 2);
      const y = height - pad - ((value - min) / spread) * (height - pad * 2);
      if (pointIndex === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  });
  ctx.fillStyle = "#f6f8fb";
  ctx.font = '760 22px "SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText("Portfolio projection paths", 22, 34);
  ctx.fillStyle = "#8f9aaa";
  ctx.font = '700 14px "SF Mono", "Roboto Mono", ui-monospace, monospace';
  ctx.fillText(`Median ${fmt.format(percentile(finals, 0.5))}`, 22, 56);
}

function randomNormal() {
  const u = Math.max(Number.MIN_VALUE, Math.random());
  const v = Math.max(Number.MIN_VALUE, Math.random());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const index = Math.min(values.length - 1, Math.max(0, Math.floor(pct * (values.length - 1))));
  return values[index];
}

function updateOrderPreview() {
  const estimate = document.querySelector("#orderEstimate");
  const qtyInput = document.querySelector("#qtyInput");
  if (!estimate || !qtyInput) return;
  const quote = quotes[selectedSymbol];
  const qty = Number(qtyInput.value);
  if (!quote || !Number.isFinite(qty) || qty <= 0) {
    estimate.textContent = "-";
    return;
  }
  const unit = tradeSide === "option" ? estimateOptionPremium(quote.price) * 100 : quote.price;
  estimate.textContent = fmt.format(qty * unit);
}

function setQuickSize(size) {
  const user = currentUser();
  const quote = quotes[selectedSymbol];
  const input = document.querySelector("#qtyInput");
  if (!quote || !input) return;
  const basis = positionValueForAction(tradeSide, selectedSymbol);
  const pct = size === "max" ? 1 : Number(size);
  const unitCost = tradeSide === "option" ? estimateOptionPremium(quote.price) * 100 : quote.price;
  const qty = Math.floor((basis * pct) / unitCost * 10000) / 10000;
  input.value = Math.max(0.0001, qty || 0).toString();
  updateOrderPreview();
}

function placeTrade(event) {
  event.preventDefault();
  const user = currentUser();
  const quote = quotes[selectedSymbol];
  const qty = Number(document.querySelector("#qtyInput").value);
  if (marketDataStatus === "stale") return notify("Refresh market data before placing a trade.");
  if (!quote || !Number.isFinite(qty) || qty <= 0) return notify("Enter a valid trade size after the quote loads.");
  const price = quote.price;
  let ok = false;
  if (tradeSide === "buy") ok = buyStock(user, selectedSymbol, qty, price);
  if (tradeSide === "sell") ok = sellStock(user, selectedSymbol, qty, price);
  if (tradeSide === "short") ok = shortStock(user, selectedSymbol, qty, price);
  if (tradeSide === "option") ok = buyOption(user, selectedSymbol, qty, price, document.querySelector("#optionType").value);
  if (!ok) return;
  saveDb();
  renderDashboard();
  showFillConfirmation(lastFill);
}

function handlePositionAction(button) {
  const user = currentUser();
  const action = button.dataset.action;
  const symbol = button.dataset.symbol;
  let ok = false;
  if (action === "sell") {
    const position = user.holdings[symbol];
    const price = quotes[symbol]?.price || position?.avg;
    if (position && price) ok = sellStock(user, symbol, position.qty, price);
  }
  if (action === "cover") {
    const position = user.shorts[symbol];
    const price = quotes[symbol]?.price || position?.avg;
    if (position && price) ok = buyStock(user, symbol, position.qty, price);
  }
  if (action === "close-option") ok = closeOption(Number(button.dataset.index), false);
  if (!ok) return;
  saveDb();
  renderDashboard();
}

function buyStock(user, symbol, qty, price) {
  const cover = applyShortCover(user, symbol, qty, price);
  if (!cover.ok) return false;
  qty -= cover.covered;
  if (qty <= 0.000001) return true;
  const total = qty * price;
  if (user.cash < total) return tradeError("Not enough cash for that buy.");
  const current = user.holdings[symbol] || { qty: 0, avg: 0 };
  const nextQty = current.qty + qty;
  current.avg = (current.avg * current.qty + total) / nextQty;
  current.qty = nextQty;
  user.holdings[symbol] = current;
  user.cash -= total;
  return tradeSuccess(user, "buy", symbol, qty, price, total);
}

function sellStock(user, symbol, qty, price) {
  const current = user.holdings[symbol];
  if (!current || current.qty < qty) return tradeError("You do not own enough shares.");
  const total = qty * price;
  current.qty -= qty;
  if (current.qty <= 0.000001) delete user.holdings[symbol];
  user.cash += total;
  return tradeSuccess(user, "sell", symbol, qty, price, total);
}

function shortStock(user, symbol, qty, price) {
  const proceeds = qty * price;
  const margin = proceeds * 0.5;
  if (user.cash < margin) return tradeError("Shorts require 50% cash margin.");
  const current = user.shorts[symbol] || { qty: 0, avg: 0, margin: 0 };
  const nextQty = current.qty + qty;
  current.avg = (current.avg * current.qty + proceeds) / nextQty;
  current.qty = nextQty;
  current.margin += margin;
  user.shorts[symbol] = current;
  user.cash -= margin;
  return tradeSuccess(user, "short", symbol, qty, price, proceeds);
}

function buyOption(user, symbol, contracts, underlyingPrice, type) {
  const premium = estimateOptionPremium(underlyingPrice);
  const total = contracts * premium * 100;
  if (user.cash < total) return tradeError("Not enough cash for those contracts.");
  user.cash -= total;
  user.options.push({
    symbol,
    type,
    contracts,
    premium,
    strike: Math.round(underlyingPrice),
    underlyingAtOpen: underlyingPrice,
    openedAt: Date.now(),
    expiresAt: Date.now() + 30 * 86400000,
  });
  return tradeSuccess(user, `${type} option`, symbol, contracts, premium, total);
}

function closeOption(index, rerender = true) {
  const user = currentUser();
  const option = user.options[index];
  if (!option) return false;
  const underlying = quotes[option.symbol]?.price || option.underlyingAtOpen;
  const mark = markOption(option, underlying);
  const total = mark * option.contracts * 100;
  user.cash += total;
  user.options.splice(index, 1);
  record(user, "close option", option.symbol, option.contracts, mark, total);
  saveDb();
  if (rerender) renderDashboard();
  return true;
}

function record(user, side, symbol, qty, price, total) {
  user.history.push({ side, symbol, qty, price, total, time: Date.now() });
  if (user.history.length > 250) user.history = user.history.slice(-250);
  notify(`${side.toUpperCase()} order filled.`);
}

function getMetrics(user) {
  return calculateMetrics(user, quotes);
}

window.addEventListener("resize", () => {
  drawChart();
  drawPortfolioMap(currentUser());
  drawTimeMachine();
});
window.addEventListener("keydown", (event) => {
  const key = event.key.toLowerCase();
  if ((event.metaKey || event.ctrlKey) && key === "k") {
    event.preventDefault();
    commandPaletteOpen = !commandPaletteOpen;
    renderDashboard();
  }
  if (event.key === "Escape" && commandPaletteOpen) {
    commandPaletteOpen = false;
    renderDashboard();
  }
});
function scheduleRefresh() {
  clearInterval(refreshTimer);
  const seconds = currentUser()?.settings?.refreshSeconds || 45;
  refreshTimer = setInterval(() => refreshQuotes(true), seconds * 1000);
}

export function startApp() {
  app();
}
