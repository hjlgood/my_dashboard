import { addDays, finite, rawNumber, safeDivide } from "./utils.js";
import { parseChart, parseQuote, quoteTrendRow, unwrapEndpoint } from "./yahoo.js";

// Quote currencies Yahoo prices in minor units: pence, cents, agorot.
export const CURRENCY_SUBUNITS = Object.freeze({ GBp: ["GBP", 0.01], GBX: ["GBP", 0.01], ZAc: ["ZAR", 0.01], ILA: ["ILS", 0.01] });
export const ESTIMATE_RATE_AMBIGUOUS_FACTOR = 1.5;
export const SHARE_COUNT_SERIES = /(Shares|ShareIssued)/;

export function currencyUnit(code) {
  const subunit = CURRENCY_SUBUNITS[code];
  return subunit ? { base: subunit[0], scale: subunit[1] } : { base: code, scale: 1 };
}

export function statementCurrency(payload) {
  const counts = new Map();
  for (const block of unwrapEndpoint(payload, "fundamentals")?.timeseries?.result || []) {
    for (const [name, rows] of Object.entries(block || {})) {
      if (!/^(annual|quarterly)/.test(name) || SHARE_COUNT_SERIES.test(name) || !Array.isArray(rows)) continue;
      for (const row of rows) {
        if (row?.currencyCode) counts.set(row.currencyCode, (counts.get(row.currencyCode) || 0) + 1);
      }
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || "";
}

// Reporting currency -> quote currency, or null when statements are already in the quote currency.
export function currencyPair(payload) {
  const quote = parseQuote(payload);
  const quoteCurrency = quote?.price?.currency || unwrapEndpoint(payload, "chart")?.chart?.result?.[0]?.meta?.currency || "USD";
  const financialCurrency = quote?.financialData?.financialCurrency
    || quote?.earnings?.financialCurrency
    || statementCurrency(payload)
    || quoteCurrency;
  const from = currencyUnit(financialCurrency);
  const to = currencyUnit(quoteCurrency);
  return {
    financialCurrency,
    quoteCurrency,
    fxSymbol: from.base === to.base ? null : `${from.base}${to.base}=X`,
    scale: from.scale / to.scale,
  };
}

export function spotRate(rates, date = null) {
  if (!rates.length) return 1;
  if (!date) return rates.at(-1).value;
  let rate = rates[0].value;
  for (const row of rates) {
    if (row.date > date) break;
    rate = row.value;
  }
  return rate;
}

// Income and cash-flow lines accrue over the fiscal year, so annual rows use that year's average rate.
export function periodRate(rates, endDate, days = 365) {
  const start = addDays(endDate, -days);
  const window = rates.filter((row) => row.date > start && row.date <= endDate).map((row) => row.value);
  return window.length ? window.reduce((sum, value) => sum + value, 0) / window.length : spotRate(rates, endDate);
}

export function convertSeriesMap(seriesMap, currency) {
  if (!currency.fxSymbol && currency.scale === 1) return seriesMap;
  const converted = new Map();
  for (const [name, rows] of seriesMap) {
    if (SHARE_COUNT_SERIES.test(name)) {
      converted.set(name, rows);
      continue;
    }
    const annual = name.startsWith("annual");
    converted.set(name, rows.map((row) => ({
      ...row,
      value: row.value * currency.scale * (annual ? periodRate(currency.rates, row.date) : spotRate(currency.rates)),
    })));
  }
  return converted;
}

// Ordinary shares per quoted share (ADS), snapped to a clean ratio (TSM 5, PDD 4, BABA 8, GMAB 0.1).
export function adrRatio(ordinaryShares, quotedShares) {
  const raw = safeDivide(ordinaryShares, quotedShares);
  if (!finite(raw) || raw <= 0 || Math.abs(Math.log(raw)) < Math.log(1.10)) return 1;
  const snapped = raw >= 1 ? Math.round(raw) : 1 / Math.round(1 / raw);
  return Math.abs(Math.log(raw / snapped)) < Math.log(1.05) ? snapped : raw;
}

// Yahoo consensus figures come either in the reporting or the quote currency; pick the rate
// that puts the estimate closest to a statement value already in the quote currency.
export function estimateRate(estimate, reference, statementRate, maxDistance = Infinity) {
  if (!(estimate > 0 && reference > 0)) return statementRate;
  const candidates = [statementRate];
  if (Math.abs(Math.log(statementRate)) >= Math.log(ESTIMATE_RATE_AMBIGUOUS_FACTOR)) candidates.push(1);
  const distance = (rate) => Math.abs(Math.log(estimate * rate / reference));
  const best = candidates.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  return distance(best) <= maxDistance ? best : NaN;
}

export function revenueEstimateRate(quote, latestAnnualRevenue, statementRate, ttmRevenue) {
  const yearAgo = rawNumber(quoteTrendRow(quote, "0y")?.revenueEstimate?.yearAgoRevenue);
  const rate = estimateRate(yearAgo, latestAnnualRevenue, statementRate, Math.log(1.5));
  if (finite(rate)) return rate;
  const implied = safeDivide(latestAnnualRevenue, yearAgo);
  const forwardRatio = safeDivide(rawNumber(quoteTrendRow(quote)?.revenueEstimate?.avg) * implied, ttmRevenue);
  return forwardRatio >= 0.5 && forwardRatio <= 3 ? implied : NaN;
}

export async function fetchFxRates(workerUrl, currency) {
  if (!currency.fxSymbol) return { ...currency, rates: [] };
  const failure = `Statements are in ${currency.financialCurrency} but prices are in ${currency.quoteCurrency}; `
    + `the ${currency.fxSymbol} exchange rate could not be loaded, so valuation metrics cannot be computed`;
  let rates;
  try {
    const response = await fetch(`${workerUrl}/api/stock?symbol=${encodeURIComponent(currency.fxSymbol)}`, { headers: { Accept: "application/json" } });
    rates = parseChart(await response.json()).prices;
  } catch (error) {
    throw new Error(`${failure} (${error instanceof Error ? error.message : error}).`);
  }
  if (!rates.length) throw new Error(`${failure}.`);
  return { ...currency, rates };
}
