export const STARTING_CASH = {
  easy: 100000,
  medium: 10000,
  expert: 2500,
};

export const DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY", "QQQ", "BTC-USD", "ETH-USD"];

export const MARKET_SECTIONS = {
  Indices: ["SPY", "QQQ", "DIA", "IWM"],
  "Mega Cap": ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA"],
};

export const CRYPTO_SECTIONS = {
  Majors: ["BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD"],
  "High Beta": ["DOGE-USD", "ADA-USD", "AVAX-USD", "LINK-USD"],
};

export const STORAGE_KEY = "stock-simulator:v2";
export const LEGACY_KEY = "stock-simulator:v1";

export const CHART_RANGES = {
  "1d": { label: "1D", interval: "5m" },
  "5d": { label: "5D", interval: "15m" },
  "1mo": { label: "1M", interval: "1d" },
  "6mo": { label: "6M", interval: "1d" },
  "1y": { label: "1Y", interval: "1wk" },
};
