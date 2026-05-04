const http = require("http");
const fs = require("fs");
const path = require("path");

loadEnv();

const PORT = toInt(process.env.PORT, 3000);
const HOST = process.env.HOST || "127.0.0.1";
const CACHE_TTL_MS = toInt(process.env.CACHE_TTL, 45) * 1000;
const FETCH_TIMEOUT_MS = toInt(process.env.FETCH_TIMEOUT_MS, 5000);
const RATE_LIMIT_WINDOW_MS = toInt(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
const RATE_LIMIT_MAX = toInt(process.env.RATE_LIMIT_MAX, 180);
const PUBLIC_DIR = path.join(__dirname, "public");
const ALLOWED_RANGES = new Set(["1d", "5d", "1mo", "6mo", "1y"]);
const ALLOWED_INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "5d", "1wk", "1mo"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

const quoteCache = new Map();
const chartCache = new Map();
const rateBuckets = new Map();

function loadEnv(filePath = path.join(__dirname, ".env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) return;
    process.env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  });
}

function toInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function logEvent(level, message, fields = {}) {
  const payload = { level, message, time: new Date().toISOString(), ...fields };
  const line = JSON.stringify(payload);
  if (level === "error") console.error(line);
  else console.log(line);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendMethodNotAllowed(res) {
  res.writeHead(405, {
    ...SECURITY_HEADERS,
    Allow: "GET, HEAD",
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

function clampSymbol(raw) {
  return String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^=-]/g, "")
    .slice(0, 18);
}

function parseSymbols(raw) {
  const symbols = String(raw || "AAPL,MSFT,NVDA,BTC-USD")
    .split(",")
    .map(clampSymbol)
    .filter(Boolean)
    .slice(0, 32);
  return [...new Set(symbols)];
}

function normalizeRange(raw, fallback = "1mo") {
  const range = String(raw || fallback).toLowerCase();
  return ALLOWED_RANGES.has(range) ? range : fallback;
}

function normalizeInterval(raw, fallback = "1d") {
  const interval = String(raw || fallback).toLowerCase();
  return ALLOWED_INTERVALS.has(interval) ? interval : fallback;
}

function fallbackQuote(symbol, now = Date.now()) {
  let seed = 0;
  for (const char of symbol) seed = (seed * 31 + char.charCodeAt(0)) >>> 0;
  const wave = Math.sin(now / 900000 + seed) * 0.018;
  const base = 20 + (seed % 55000) / 100;
  const price = Math.max(0.05, base * (1 + wave));
  const previousClose = Math.max(0.05, base * (1 - wave / 2));
  return {
    symbol,
    name: symbol,
    price,
    previousClose,
    change: price - previousClose,
    changePercent: ((price - previousClose) / previousClose) * 100,
    currency: "USD",
    marketState: "fallback",
    source: "fallback",
    asOf: now,
  };
}

async function fetchJson(url, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 StockSimulator/1.0",
        Accept: "application/json",
      },
    });
    if (!response.ok) throw new Error(`Yahoo chart request failed: ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getYahooChart(symbol, range = "1d", interval = "5m", options = {}) {
  const safeSymbol = clampSymbol(symbol);
  if (!safeSymbol) throw new Error("Missing symbol");
  const safeRange = normalizeRange(range, "1d");
  const safeInterval = normalizeInterval(interval, "5m");
  const key = `${safeSymbol}:${safeRange}:${safeInterval}`;
  const cached = chartCache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.data;

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    safeSymbol
  )}?range=${encodeURIComponent(safeRange)}&interval=${encodeURIComponent(safeInterval)}&includePrePost=false`;
  const body = await fetchJson(url, options.fetchImpl);
  const result = body.chart && body.chart.result && body.chart.result[0];
  if (!result) throw new Error("No chart result");

  const quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  const timestamps = result.timestamp || [];
  const closes = (quote && quote.close) || [];
  const points = timestamps
    .map((time, index) => ({ time: time * 1000, close: closes[index] }))
    .filter((point) => Number.isFinite(point.close));
  const meta = result.meta || {};
  const price = Number(meta.regularMarketPrice || points.at(-1)?.close || meta.previousClose || 0);
  const previousClose = Number(meta.chartPreviousClose || meta.previousClose || points[0]?.close || price);
  const data = {
    symbol: safeSymbol,
    name: meta.longName || meta.shortName || safeSymbol,
    price,
    previousClose,
    change: price - previousClose,
    changePercent: previousClose ? ((price - previousClose) / previousClose) * 100 : 0,
    currency: meta.currency || "USD",
    marketState: meta.marketState || "unknown",
    source: "yahoo",
    asOf: Date.now(),
    points,
  };
  chartCache.set(key, { time: Date.now(), data });
  return data;
}

async function getQuote(symbol, options = {}) {
  const safeSymbol = clampSymbol(symbol);
  if (!safeSymbol) throw new Error("Missing symbol");
  const cached = quoteCache.get(safeSymbol);
  if (cached && Date.now() - cached.time < CACHE_TTL_MS) return cached.data;

  const chart = await getYahooChart(safeSymbol, "1d", "5m", options);
  const data = { ...chart };
  delete data.points;
  quoteCache.set(safeSymbol, { time: Date.now(), data });
  return data;
}

function errorQuote(symbol, message = "Symbol not found") {
  return {
    symbol,
    error: message,
    source: "error",
    asOf: Date.now(),
  };
}

function rateLimit(req, res) {
  const ip = req.socket.remoteAddress || "unknown";
  const now = Date.now();
  for (const [bucketIp, bucket] of rateBuckets) {
    if (now > bucket.resetAt + RATE_LIMIT_WINDOW_MS) rateBuckets.delete(bucketIp);
  }
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  if (bucket.count <= RATE_LIMIT_MAX) return false;
  sendJson(res, 429, { error: "Too many requests", retryAfterMs: bucket.resetAt - now });
  return true;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let requested;
  try {
    requested = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  } catch {
    sendText(res, 400, "Bad request");
    return;
  }
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  const relativePath = path.relative(PUBLIC_DIR, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendText(res, 404, "Not found");
      return;
    }
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  });
}

function createRequestHandler(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  return async function handleRequest(req, res) {
    const started = Date.now();
    try {
      if (!["GET", "HEAD"].includes(req.method)) {
        sendMethodNotAllowed(res);
        return;
      }
      if (rateLimit(req, res)) return;
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, uptime: process.uptime(), cacheTtlMs: CACHE_TTL_MS });
        return;
      }
      if (url.pathname === "/api/quote") {
        const symbols = parseSymbols(url.searchParams.get("symbols"));
        const quotes = await Promise.all(
          symbols.map(async (symbol) => {
            try {
              return await getQuote(symbol, { fetchImpl });
            } catch (error) {
              logEvent("warn", "quote_lookup_failed", { symbol, error: error.message });
              return errorQuote(symbol);
            }
          })
        );
        sendJson(res, 200, { quotes });
        return;
      }
      if (url.pathname === "/api/chart") {
        const symbol = clampSymbol(url.searchParams.get("symbol") || "AAPL");
        const range = normalizeRange(url.searchParams.get("range"), "1mo");
        const interval = normalizeInterval(url.searchParams.get("interval"), "1d");
        try {
          sendJson(res, 200, await getYahooChart(symbol, range, interval, { fetchImpl }));
        } catch (error) {
          logEvent("warn", "chart_lookup_failed", { symbol, range, interval, error: error.message });
          sendJson(res, 404, { ...errorQuote(symbol), points: [] });
        }
        return;
      }
      serveStatic(req, res);
    } catch (error) {
      logEvent("error", "request_failed", { method: req.method, url: req.url, error: error.message });
      sendJson(res, 500, { error: "Server error" });
    } finally {
      logEvent("info", "request", {
        method: req.method,
        url: req.url,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    }
  };
}

function createServer(options = {}) {
  return http.createServer(createRequestHandler(options));
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    logEvent("info", "server_started", { url: `http://${HOST}:${PORT}`, cacheTtlMs: CACHE_TTL_MS });
  });
}

module.exports = {
  ALLOWED_INTERVALS,
  ALLOWED_RANGES,
  createRequestHandler,
  createServer,
  clampSymbol,
  errorQuote,
  fallbackQuote,
  getQuote,
  getYahooChart,
  normalizeInterval,
  normalizeRange,
  parseSymbols,
};
