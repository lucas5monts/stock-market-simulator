const assert = require("node:assert/strict");
const test = require("node:test");
const { clampSymbol, createRequestHandler, fallbackQuote, normalizeInterval, normalizeRange, parseSymbols } = require("../server");

function yahooBody(symbol = "AAPL") {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            longName: `${symbol} Inc.`,
            regularMarketPrice: 125,
            previousClose: 100,
            currency: "USD",
            marketState: "REGULAR",
          },
          timestamp: [1710000000, 1710000300],
          indicators: { quote: [{ close: [100, 125] }] },
        },
      ],
    },
  };
}

function makeFetch(body = yahooBody()) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function failingFetch() {
  const fetchImpl = async () => {
    throw new Error("upstream offline");
  };
  fetchImpl.calls = [];
  return fetchImpl;
}

async function request(path, fetchImpl = makeFetch(), remoteAddress = `test-${Math.random()}`, method = "GET") {
  const handler = createRequestHandler({ fetchImpl });
  const req = {
    method,
    url: path,
    headers: { host: "127.0.0.1" },
    socket: { remoteAddress },
  };
  const res = {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(chunk = "") {
      this.body += chunk;
    },
  };
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body) };
}

test("clampSymbol strips unsafe characters and bounds length", () => {
  assert.equal(clampSymbol(" aapl<script>1234567890 "), "AAPLSCRIPT12345678");
  assert.equal(clampSymbol("btc-usd"), "BTC-USD");
});

test("parseSymbols dedupes and caps symbol lists", () => {
  const symbols = parseSymbols("aapl,aapl,msft," + Array.from({ length: 40 }, (_, index) => `x${index}`).join(","));
  assert.equal(symbols[0], "AAPL");
  assert.equal(symbols[1], "MSFT");
  assert.equal(symbols.length, 31);
});

test("fallbackQuote returns deterministic shaped USD data", () => {
  const quote = fallbackQuote("ZZZ", 1710000000000);
  assert.equal(quote.symbol, "ZZZ");
  assert.equal(quote.currency, "USD");
  assert.equal(quote.source, "fallback");
  assert.ok(Number.isFinite(quote.price));
  assert.ok(Number.isFinite(quote.changePercent));
});

test("normalizes chart range and interval allowlists", () => {
  assert.equal(normalizeRange("6mo"), "6mo");
  assert.equal(normalizeRange("../../etc/passwd"), "1mo");
  assert.equal(normalizeInterval("15m"), "15m");
  assert.equal(normalizeInterval("file://x"), "1d");
});

test("/api/quote returns mocked Yahoo quote data", async () => {
  const fetchImpl = makeFetch(yahooBody("AAPL"));
  const response = await request("/api/quote?symbols=AAPL", fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(response.body.quotes[0].symbol, "AAPL");
  assert.equal(response.body.quotes[0].price, 125);
});

test("/api/chart validates range and interval before upstream fetch", async () => {
  const fetchImpl = makeFetch(yahooBody("MSFT"));
  const response = await request("/api/chart?symbol=MSFT&range=bad&interval=bad", fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(response.body.points.length, 2);
  assert.match(fetchImpl.calls[0], /range=1mo/);
  assert.match(fetchImpl.calls[0], /interval=1d/);
});

test("/api/chart returns an error instead of fallback prices on upstream failure", async () => {
  const response = await request("/api/chart?symbol=NOTREAL&range=1mo&interval=1d", failingFetch());
  assert.equal(response.status, 404);
  assert.equal(response.body.symbol, "NOTREAL");
  assert.equal(response.body.source, "error");
  assert.deepEqual(response.body.points, []);
});

test("/healthz reports readiness", async () => {
  const response = await request("/healthz");
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.match(response.headers["Content-Security-Policy"], /default-src 'self'/);
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
});

test("rejects non-read methods", async () => {
  const response = await request("/api/quote?symbols=AAPL", makeFetch(), "method-test", "POST");
  assert.equal(response.status, 405);
  assert.equal(response.headers.Allow, "GET, HEAD");
});
