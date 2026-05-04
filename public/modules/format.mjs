export const fmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const qtyFmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function normalizeSymbol(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.^=-]/g, "")
    .slice(0, 18);
}
