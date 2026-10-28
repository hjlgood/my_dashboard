import { dateKey, finite, rawNumber } from "./utils.js";

export function unwrapEndpoint(payload, endpoint) {
  return payload?.data?.[endpoint]?.data ?? null;
}

export function parseChart(payload) {
  const body = unwrapEndpoint(payload, "chart");
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo chart endpoint returned no usable price history.");
  const timestamps = result.timestamp || [];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose || [];
  const closes = result.indicators?.quote?.[0]?.close || [];
  const byDate = new Map();
  timestamps.forEach((timestamp, index) => {
    const adjustedValue = rawNumber(adjusted[index]);
    const value = finite(adjustedValue) ? adjustedValue : rawNumber(closes[index]);
    // Later bars for the same day (e.g. a live intraday bar) replace earlier ones.
    if (finite(value) && value > 0) byDate.set(new Date(timestamp * 1000).toISOString().slice(0, 10), value);
  });
  const prices = [...byDate].map(([date, value]) => ({ date, value })).sort((a, b) => a.date.localeCompare(b.date));
  if (!prices.length) throw new Error("Price history is empty.");
  return { prices, meta: result.meta || {} };
}

export function collectTimeseries(payload) {
  const body = unwrapEndpoint(payload, "fundamentals");
  const blocks = body?.timeseries?.result;
  if (!Array.isArray(blocks)) throw new Error("Yahoo fundamentals endpoint returned no timeseries data.");
  const result = new Map();
  for (const block of blocks) {
    for (const [name, rows] of Object.entries(block || {})) {
      if (!/^(annual|quarterly)/.test(name) || !Array.isArray(rows)) continue;
      const parsed = rows.map((row) => ({
        date: dateKey(row.asOfDate || (finite(row.timestamp) ? row.timestamp * 1000 : null)),
        value: rawNumber(row.reportedValue),
      })).filter((row) => row.date && finite(row.value));
      if (!result.has(name)) result.set(name, []);
      result.get(name).push(...parsed);
    }
  }
  for (const [name, rows] of result.entries()) {
    const byDate = new Map(rows.map((row) => [row.date, row]));
    result.set(name, [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)));
  }
  return result;
}

export function parseQuote(payload) {
  const body = unwrapEndpoint(payload, "quote");
  return body?.quoteSummary?.result?.[0] || {};
}

export function firstSeries(seriesMap, prefix, aliases) {
  for (const alias of aliases) {
    const rows = seriesMap.get(`${prefix}${alias}`);
    if (rows?.length) return rows;
  }
  return [];
}

export function latestValue(rows, fallback = NaN) {
  return rows.length ? rows.at(-1).value : fallback;
}

export function sumRecent(rows, count = 4, fallback = NaN) {
  const values = rows.slice(-count).map((row) => row.value).filter(finite);
  return values.length === count ? values.reduce((sum, value) => sum + value, 0) : fallback;
}

export function meanRecent(rows, count = 4) {
  const values = rows.slice(-count).map((row) => row.value).filter(finite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

export function nearestAnnualValue(rows, date, maxDays = 120) {
  let best = null;
  for (const row of rows) {
    const distance = Math.abs(new Date(row.date) - new Date(date)) / 86400000;
    if (distance <= maxDays && (!best || distance < best.distance)) best = { distance, value: row.value };
  }
  return best?.value ?? NaN;
}

export function quoteTrendRow(quote, period = "+1y") {
  return (quote?.earningsTrend?.trend || []).find((row) => row.period === period) || {};
}
