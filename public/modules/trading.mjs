import { STARTING_CASH } from "./constants.mjs";

export function shortAccountValue(position, last) {
  return (position.margin || 0) + (position.avg - last) * position.qty;
}

export function shortLiability(position, last) {
  return last * position.qty;
}

export function realizedShortCashDelta(position, coverQty, price) {
  const releasedMargin = position.margin * (coverQty / position.qty);
  const profit = (position.avg - price) * coverQty;
  return releasedMargin + profit;
}

export function estimateOptionPremium(price) {
  return Math.max(0.1, price * 0.045);
}

export function markOption(option, underlying, now = Date.now()) {
  const daysLeft = Math.max(0, (option.expiresAt - now) / 86400000);
  const intrinsic = option.type === "call" ? Math.max(0, underlying - option.strike) : Math.max(0, option.strike - underlying);
  const timeValue = Math.max(0.05, option.underlyingAtOpen * 0.018 * (daysLeft / 30));
  return intrinsic + timeValue;
}

export function getMetrics(user, quotes = {}, now = Date.now()) {
  const start = STARTING_CASH[user.difficulty] || STARTING_CASH.medium;
  const longValue = Object.entries(user.holdings).reduce((sum, [symbol, position]) => sum + (quotes[symbol]?.price || position.avg) * position.qty, 0);
  const shortStats = Object.entries(user.shorts).reduce(
    (stats, [symbol, position]) => {
      const last = quotes[symbol]?.price || position.avg;
      stats.margin += position.margin || 0;
      stats.pnl += (position.avg - last) * position.qty;
      stats.liability += shortLiability(position, last);
      return stats;
    },
    { margin: 0, pnl: 0, liability: 0 }
  );
  const optionValue = user.options.reduce((sum, option) => sum + markOption(option, quotes[option.symbol]?.price || option.underlyingAtOpen, now) * option.contracts * 100, 0);
  const netWorth = user.cash + longValue + optionValue + shortStats.margin + shortStats.pnl;
  const exposure = longValue + optionValue + shortStats.liability;
  return { start, longValue, optionValue, shortStats, exposure, netWorth, returnPct: ((netWorth - start) / start) * 100 };
}

export function positionsCount(user) {
  return Object.keys(user.holdings).length + Object.keys(user.shorts).length + user.options.length;
}
