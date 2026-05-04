export async function fetchQuotes(symbols) {
  const response = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols.join(","))}`);
  if (!response.ok) throw new Error(`Quote request failed: ${response.status}`);
  return response.json();
}

export async function fetchChart(symbol, range, interval) {
  const response = await fetch(`/api/chart?symbol=${encodeURIComponent(symbol)}&range=${range}&interval=${interval}`);
  if (!response.ok) throw new Error(`Chart request failed: ${response.status}`);
  return response.json();
}
