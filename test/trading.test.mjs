import assert from "node:assert/strict";
import test from "node:test";
import { estimateOptionPremium, getMetrics, markOption, realizedShortCashDelta, shortAccountValue, shortLiability } from "../public/modules/trading.mjs";

test("short math tracks liability, margin, and realized cover cash", () => {
  const position = { qty: 10, avg: 100, margin: 500 };
  assert.equal(shortLiability(position, 90), 900);
  assert.equal(shortAccountValue(position, 90), 600);
  assert.equal(realizedShortCashDelta(position, 5, 90), 300);
  assert.equal(realizedShortCashDelta(position, 10, 120), 300);
});

test("option premiums and marks include intrinsic plus time value", () => {
  const now = 1710000000000;
  const option = {
    symbol: "AAPL",
    type: "call",
    contracts: 1,
    premium: 4.5,
    strike: 100,
    underlyingAtOpen: 100,
    expiresAt: now + 30 * 86400000,
  };
  assert.equal(estimateOptionPremium(100), 4.5);
  assert.equal(markOption(option, 110, now), 11.8);
});

test("portfolio metrics include longs, shorts, options, and cash", () => {
  const now = 1710000000000;
  const user = {
    difficulty: "medium",
    cash: 9000,
    holdings: { AAPL: { qty: 2, avg: 100 } },
    shorts: { TSLA: { qty: 1, avg: 200, margin: 100 } },
    options: [
      {
        symbol: "AAPL",
        type: "call",
        contracts: 1,
        premium: 4.5,
        strike: 100,
        underlyingAtOpen: 100,
        expiresAt: now + 30 * 86400000,
      },
    ],
  };
  const metrics = getMetrics(user, { AAPL: { price: 110 }, TSLA: { price: 150 } }, now);
  assert.equal(metrics.longValue, 220);
  assert.equal(metrics.shortStats.pnl, 50);
  assert.equal(metrics.shortStats.liability, 150);
  assert.equal(metrics.optionValue, 1180);
  assert.equal(metrics.netWorth, 10550);
});
