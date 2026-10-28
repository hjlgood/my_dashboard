export function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

export function rawNumber(value) {
  if (finite(value)) return value;
  if (value && typeof value === "object") {
    if (finite(value.raw)) return value.raw;
    if (finite(value.value)) return value.value;
    return NaN;
  }
  // Number(null), Number("") and Number(false) are 0; Yahoo uses null for missing bars.
  if (typeof value !== "string" || !value.trim()) return NaN;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

export function safeDivide(numerator, denominator, fallback = NaN) {
  return finite(numerator) && finite(denominator) && denominator !== 0
    ? numerator / denominator
    : fallback;
}

export function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

export function sortedFinite(values) {
  return values.filter(finite).sort((a, b) => a - b);
}

export function quantile(values, probability) {
  const clean = sortedFinite(values);
  if (!clean.length) return NaN;
  if (clean.length === 1) return clean[0];
  const position = (clean.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return clean[lower + 1] === undefined
    ? clean[lower]
    : clean[lower] + fraction * (clean[lower + 1] - clean[lower]);
}

export function median(values) {
  return quantile(values, 0.5);
}

export function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function addYears(dateString, years) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

export function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function yearStart(dateString) {
  return `${dateString.slice(0, 4)}-01-01`;
}

export function seriesCagr(rows, field) {
  const usable = rows.filter((row) => finite(row[field]) && row[field] > 0);
  if (usable.length < 2) return NaN;
  const first = usable[0];
  const last = usable.at(-1);
  const years = (new Date(last.date) - new Date(first.date)) / (365.25 * 86400000);
  if (years <= 0 || first[field] <= 0 || last[field] <= 0) return NaN;
  return (last[field] / first[field]) ** (1 / years) - 1;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]);
}
