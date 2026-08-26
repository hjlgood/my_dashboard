"use strict";

const MODEL = Object.freeze({
  horizonYears: 1,
  reverseYears: 10,
  requiredReturn: 0.10,
  reversion: 0.25,
  growthSpread: 0.06,
  forwardRevenueWeight: 0.50,
  bearMultipleDiscount: 0.25,
  maxPeMultiple: 100,
  yields: [0.03, 0.04, 0.05, 0.06, 0.08],
});

const COLORS = Object.freeze({
  bg: "#050708",
  text: "#dce4e6",
  muted: "#849196",
  grid: "rgba(122,122,122,0.18)",
  cyan: "#00e5e5",
  yellow: "#ffd43b",
  red: "#ff4d36",
  orange: "#ff9f1c",
  lime: "#7fd84f",
  green: "#35d04f",
  purple: "#c05cff",
});

const YIELD_COLORS = [COLORS.red, COLORS.orange, COLORS.yellow, COLORS.lime, COLORS.green];
const BAND_COLORS = [COLORS.green, COLORS.lime, COLORS.yellow, COLORS.orange, COLORS.red];
const BAND_SMOOTH = 0.80;
const CHART_GRID = Object.freeze({ left: 64, right: 68, top: 44, bottom: 53 });
const HORIZONTAL_CROSSHAIR_ID = "manual-horizontal-crosshair";
const chartInstances = new Map();

const dom = {
  form: document.querySelector("#stock-form"),
  ticker: document.querySelector("#ticker-input"),
  workerUrl: document.querySelector("#worker-url-input"),
  button: document.querySelector("#analyze-button"),
  statusDot: document.querySelector("#status-dot"),
  statusText: document.querySelector("#status-text"),
  elapsed: document.querySelector("#elapsed-text"),
  title: document.querySelector("#company-title"),
  marketSummary: document.querySelector("#market-summary"),
  dashboard: document.querySelector("#dashboard"),
  diagnostic: document.querySelector("#diagnostic-output"),
};

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function rawNumber(value) {
  if (finite(value)) return value;
  if (value && typeof value === "object") {
    if (finite(value.raw)) return value.raw;
    if (finite(value.value)) return value.value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function safeDivide(numerator, denominator, fallback = NaN) {
  return finite(numerator) && finite(denominator) && denominator !== 0
    ? numerator / denominator
    : fallback;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function sortedFinite(values) {
  return values.filter(finite).sort((a, b) => a - b);
}

function quantile(values, probability) {
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

function median(values) {
  return quantile(values, 0.5);
}

function dateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function addYears(dateString, years) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function yearStart(dateString) {
  return `${dateString.slice(0, 4)}-01-01`;
}

function seriesCagr(rows, field) {
  const usable = rows.filter((row) => finite(row[field]) && row[field] > 0);
  if (usable.length < 2) return NaN;
  const first = usable[0];
  const last = usable.at(-1);
  const years = (new Date(last.date) - new Date(first.date)) / (365.25 * 86400000);
  if (years <= 0 || first[field] <= 0 || last[field] <= 0) return NaN;
  return (last[field] / first[field]) ** (1 / years) - 1;
}

function formatNumber(value, digits = 2) {
  return finite(value)
    ? value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "N/A";
}

function formatPercent(value, digits = 1, signed = false) {
  if (!finite(value)) return "N/A";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

function formatMultiple(value, digits = 1) {
  return finite(value) ? `${value.toFixed(digits)}x` : "N/A";
}

function currencySymbol(currency) {
  return ({ USD: "$", EUR: "€", GBP: "£", JPY: "¥", KRW: "₩", CNY: "¥", CAD: "C$", AUD: "A$" })[currency] || `${currency || ""} `;
}

function formatMoney(value, currency, digits = 2) {
  return finite(value) ? `${currencySymbol(currency)}${formatNumber(value, digits)}` : "N/A";
}

function formatCompactMoney(value, currency) {
  if (!finite(value)) return "N/A";
  const abs = Math.abs(value);
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"]];
  const unit = units.find(([threshold]) => abs >= threshold);
  return unit
    ? `${currencySymbol(currency)}${(value / unit[0]).toFixed(2)}${unit[1]}`
    : formatMoney(value, currency, 0);
}

function unwrapEndpoint(payload, endpoint) {
  return payload?.data?.[endpoint]?.data ?? null;
}

function parseChart(payload) {
  const body = unwrapEndpoint(payload, "chart");
  const result = body?.chart?.result?.[0];
  if (!result) throw new Error("Yahoo chart endpoint returned no usable price history.");
  const timestamps = result.timestamp || [];
  const adjusted = result.indicators?.adjclose?.[0]?.adjclose;
  const closes = adjusted || result.indicators?.quote?.[0]?.close || [];
  const prices = timestamps.map((timestamp, index) => ({
    date: new Date(timestamp * 1000).toISOString().slice(0, 10),
    value: rawNumber(closes[index]),
  })).filter((row) => finite(row.value));
  if (!prices.length) throw new Error("Price history is empty.");
  return { prices, meta: result.meta || {} };
}

function collectTimeseries(payload) {
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

function parseQuote(payload) {
  const body = unwrapEndpoint(payload, "quote");
  return body?.quoteSummary?.result?.[0] || {};
}

function firstSeries(seriesMap, prefix, aliases) {
  for (const alias of aliases) {
    const rows = seriesMap.get(`${prefix}${alias}`);
    if (rows?.length) return rows;
  }
  return [];
}

function latestValue(rows, fallback = NaN) {
  return rows.length ? rows.at(-1).value : fallback;
}

function sumRecent(rows, count = 4, fallback = NaN) {
  const values = rows.slice(-count).map((row) => row.value).filter(finite);
  return values.length === count ? values.reduce((sum, value) => sum + value, 0) : fallback;
}

function meanRecent(rows, count = 4) {
  const values = rows.slice(-count).map((row) => row.value).filter(finite);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
}

function nearestAnnualValue(rows, date, maxDays = 120) {
  let best = null;
  for (const row of rows) {
    const distance = Math.abs(new Date(row.date) - new Date(date)) / 86400000;
    if (distance <= maxDays && (!best || distance < best.distance)) best = { distance, value: row.value };
  }
  return best?.value ?? NaN;
}

function quoteTrendRow(quote, period = "+1y") {
  return (quote?.earningsTrend?.trend || []).find((row) => row.period === period) || {};
}

function buildAnnualFundamentals(seriesMap) {
  const annual = (aliases) => firstSeries(seriesMap, "annual", aliases);
  const revenueRows = annual(["TotalRevenue"]);
  const sharesRows = annual(["DilutedAverageShares", "BasicAverageShares", "OrdinarySharesNumber", "ShareIssued"]);
  const fcfRows = annual(["FreeCashFlow"]);
  const sbcRows = annual(["StockBasedCompensation"]);
  const epsRows = annual(["DilutedEPS", "BasicEPS"]);
  const operatingRows = annual(["OperatingIncome", "TotalOperatingIncomeAsReported"]);
  const pretaxRows = annual(["PretaxIncome"]);
  const taxRows = annual(["TaxProvision"]);
  const investedRows = annual(["InvestedCapital"]);
  const equityRows = annual(["StockholdersEquity", "CommonStockEquity"]);
  const debtRows = annual(["TotalDebt"]);
  const cashRows = annual(["CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalents"]);
  const noSbcLine = sbcRows.length === 0;

  return revenueRows.map((revenueRow) => {
    const date = revenueRow.date;
    const shares = nearestAnnualValue(sharesRows, date);
    const fcf = nearestAnnualValue(fcfRows, date);
    const sbcFound = nearestAnnualValue(sbcRows, date);
    const sbc = noSbcLine ? 0 : sbcFound;
    const eps = nearestAnnualValue(epsRows, date);
    const operatingIncome = nearestAnnualValue(operatingRows, date);
    const pretaxIncome = nearestAnnualValue(pretaxRows, date);
    const tax = nearestAnnualValue(taxRows, date);
    let investedCapital = nearestAnnualValue(investedRows, date);
    if (!finite(investedCapital) || investedCapital <= 0) {
      investedCapital = nearestAnnualValue(equityRows, date)
        + nearestAnnualValue(debtRows, date)
        - nearestAnnualValue(cashRows, date);
    }
    const taxRate = finite(tax) && finite(pretaxIncome) ? clamp(safeDivide(tax, pretaxIncome, 0.21), 0, 0.35) : 0.21;
    if (![shares, revenueRow.value, fcf, sbc, eps].every(finite) || shares <= 0) return null;
    return {
      date,
      revenuePerShare: revenueRow.value / shares,
      fcfPerShare: fcf / shares,
      sbcPerShare: sbc / shares,
      adjustedFcfPerShare: (fcf - sbc) / shares,
      eps,
      roic: safeDivide(operatingIncome * (1 - taxRate), investedCapital),
      shares,
    };
  }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
}

function buildDashboardModel(payload, ticker) {
  const { prices, meta } = parseChart(payload);
  const seriesMap = collectTimeseries(payload);
  const quote = parseQuote(payload);
  const annualRows = buildAnnualFundamentals(seriesMap);
  const quarterly = (aliases) => firstSeries(seriesMap, "quarterly", aliases);
  const trend = quoteTrendRow(quote);

  const currentPrice = rawNumber(meta.regularMarketPrice) || prices.at(-1).value;
  let currentShares = rawNumber(quote?.defaultKeyStatistics?.sharesOutstanding);
  if (!finite(currentShares) || currentShares <= 0) {
    currentShares = latestValue(quarterly(["OrdinarySharesNumber", "ShareIssued"]));
  }
  if (!finite(currentShares) || currentShares <= 0) {
    currentShares = latestValue(firstSeries(seriesMap, "annual", ["OrdinarySharesNumber", "ShareIssued", "DilutedAverageShares"]));
  }
  if (!finite(currentShares) || currentShares <= 0) throw new Error("Current shares outstanding are unavailable.");

  const revenue = sumRecent(quarterly(["TotalRevenue"]));
  const operatingIncome = sumRecent(quarterly(["OperatingIncome", "TotalOperatingIncomeAsReported"]));
  const netIncome = sumRecent(quarterly(["NetIncome"]));
  const pretaxIncome = sumRecent(quarterly(["PretaxIncome"]));
  const tax = sumRecent(quarterly(["TaxProvision"]));
  const ebitda = sumRecent(quarterly(["EBITDA", "NormalizedEBITDA"]));
  const interestExpense = Math.abs(sumRecent(quarterly(["InterestExpense", "InterestExpenseNonOperating"])));
  const eps = sumRecent(quarterly(["DilutedEPS", "BasicEPS"]));
  const fcf = sumRecent(quarterly(["FreeCashFlow"]));
  const quarterlySbc = quarterly(["StockBasedCompensation"]);
  const annualSbc = firstSeries(seriesMap, "annual", ["StockBasedCompensation"]);
  let sbc = sumRecent(quarterlySbc);
  let sbcSource = "latest four quarters";
  if (!finite(sbc)) {
    if (annualSbc.length) {
      sbc = latestValue(annualSbc);
      sbcSource = "latest annual fallback";
    } else {
      sbc = 0;
      sbcSource = "no SBC line; assumed zero";
    }
  }

  const latestQuarterDates = quarterly(["TotalRevenue"]).map((row) => row.date);
  const ttmDate = latestQuarterDates.at(-1) || prices.at(-1).date;
  const balance = (aliases) => quarterly(aliases);
  const cash = latestValue(balance(["CashCashEquivalentsAndShortTermInvestments", "CashAndCashEquivalents"]));
  const totalDebt = latestValue(balance(["TotalDebt"]));
  const reportedNetDebt = latestValue(balance(["NetDebt"]));
  const netDebt = finite(reportedNetDebt) ? reportedNetDebt : totalDebt - cash;
  const equity = latestValue(balance(["StockholdersEquity", "CommonStockEquity"]));
  let investedCapital = latestValue(balance(["InvestedCapital"]));
  if (!finite(investedCapital) || investedCapital <= 0) investedCapital = equity + totalDebt - cash;
  const taxRate = finite(tax) && finite(pretaxIncome) ? clamp(safeDivide(tax, pretaxIncome, 0.21), 0, 0.35) : 0.21;
  const roic = safeDivide(operatingIncome * (1 - taxRate), investedCapital);
  const adjustedFcf = fcf - sbc;
  const currentAdjustedFcfPerShare = safeDivide(adjustedFcf, currentShares);

  const ttmRow = {
    date: ttmDate,
    revenuePerShare: safeDivide(revenue, currentShares),
    fcfPerShare: safeDivide(fcf, currentShares),
    sbcPerShare: safeDivide(sbc, currentShares),
    adjustedFcfPerShare: currentAdjustedFcfPerShare,
    eps,
    roic,
    shares: currentShares,
  };
  const merged = new Map(annualRows.map((row) => [row.date, row]));
  const sameDateAnnual = merged.get(ttmRow.date) || {};
  merged.set(ttmRow.date, Object.fromEntries(
    Object.entries({ ...sameDateAnnual, ...ttmRow }).map(([key, value]) => [
      key,
      key !== "date" && !finite(value) && finite(sameDateAnnual[key]) ? sameDateAnnual[key] : value,
    ]),
  ));
  const fundamentals = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));

  const historicalCagrs = {
    revenue: seriesCagr(fundamentals, "revenuePerShare"),
    adjustedFcf: seriesCagr(fundamentals, "adjustedFcfPerShare"),
    eps: seriesCagr(fundamentals, "eps"),
  };
  const validGrowth = Object.values(historicalCagrs).filter((value) => finite(value) && value > -0.30 && value < 0.50);
  const historicalBaseGrowth = median(validGrowth);
  const analystRevenue = rawNumber(trend?.revenueEstimate?.avg);
  const analystRevenuePerShare = analystRevenue > 0 ? analystRevenue / currentShares : NaN;
  let forwardRevenueGrowth = rawNumber(trend?.revenueEstimate?.growth);
  const yearAgoRevenue = rawNumber(trend?.revenueEstimate?.yearAgoRevenue);
  if (!finite(forwardRevenueGrowth) && analystRevenue > 0 && yearAgoRevenue > 0) {
    forwardRevenueGrowth = analystRevenue / yearAgoRevenue - 1;
  }
  const analystEps = rawNumber(trend?.earningsEstimate?.avg);
  const unboundedBase = finite(historicalBaseGrowth)
    ? (finite(forwardRevenueGrowth)
      ? historicalBaseGrowth * (1 - MODEL.forwardRevenueWeight) + forwardRevenueGrowth * MODEL.forwardRevenueWeight
      : historicalBaseGrowth)
    : forwardRevenueGrowth;
  const baseGrowth = finite(unboundedBase) ? clamp(unboundedBase, 0.03, 0.18) : NaN;
  const growthScenarios = {
    Bear: finite(baseGrowth) ? Math.max(-0.02, baseGrowth - MODEL.growthSpread) : NaN,
    Base: baseGrowth,
    Bull: finite(baseGrowth) ? Math.min(0.25, baseGrowth + MODEL.growthSpread) : NaN,
  };

  const adjustedAnchors = fundamentals.filter((row) => finite(row.adjustedFcfPerShare));
  const adjustedFcfSpline = createPchipInterpolator(
    adjustedAnchors,
    "adjustedFcfPerShare",
    true,
  );
  const valuationMultiples = prices.map((row) => {
    const driver = adjustedFcfSpline(row.date);
    return driver > 0 ? row.value / driver : NaN;
  }).filter((value) => finite(value) && value > 0);
  let q25;
  let medianMultiple;
  let q75;
  const positiveCurrentFcf = currentAdjustedFcfPerShare > 0;
  const currentMultiple = positiveCurrentFcf ? currentPrice / currentAdjustedFcfPerShare : NaN;
  if (valuationMultiples.length >= 30) {
    const low = quantile(valuationMultiples, 0.05);
    const high = quantile(valuationMultiples, 0.95);
    const clipped = valuationMultiples.map((value) => clamp(value, low, high));
    q25 = quantile(clipped, 0.25);
    medianMultiple = quantile(clipped, 0.50);
    q75 = quantile(clipped, 0.75);
  } else if (positiveCurrentFcf) {
    q25 = currentMultiple * 0.9;
    medianMultiple = currentMultiple;
    q75 = currentMultiple * 1.2;
  }
  const partialMultiple = (reference) => Math.exp((1 - MODEL.reversion) * Math.log(currentMultiple) + MODEL.reversion * Math.log(reference));
  let exitMultiples = { Bear: NaN, Base: NaN, Bull: NaN };
  if (positiveCurrentFcf && [q25, medianMultiple, q75].every((value) => finite(value) && value > 0)) {
    const bear = Math.min(currentMultiple * (1 - MODEL.bearMultipleDiscount), partialMultiple(q25));
    const base = Math.max(partialMultiple(medianMultiple), bear * 1.001);
    const bull = Math.max(partialMultiple(q75), currentMultiple * 1.10, base * 1.001);
    exitMultiples = { Bear: bear, Base: base, Bull: bull };
  }
  const scenarios = {};
  for (const name of ["Bear", "Base", "Bull"]) {
    const growth = growthScenarios[name];
    const multiple = exitMultiples[name];
    const targetFcf = currentAdjustedFcfPerShare * (1 + growth);
    const targetPrice = positiveCurrentFcf && finite(growth) && multiple > 0 ? targetFcf * multiple : NaN;
    scenarios[name] = {
      growth,
      multiple,
      targetFcf,
      targetPrice,
      totalReturn: finite(targetPrice) ? targetPrice / currentPrice - 1 : NaN,
    };
  }

  const secondStageGrowth = finite(baseGrowth) ? Math.max(0.03, baseGrowth * 0.5) : NaN;
  const baseTenYearCagr = finite(baseGrowth)
    ? (((1 + baseGrowth) ** 5 * (1 + secondStageGrowth) ** 5) ** 0.1 - 1)
    : NaN;
  const reverseImpliedGrowth = positiveCurrentFcf && exitMultiples.Base > 0
    ? solveGrowth(currentPrice, currentAdjustedFcfPerShare, MODEL.requiredReturn, exitMultiples.Base, MODEL.reverseYears)
    : NaN;
  const baseImpliedIrr = positiveCurrentFcf && exitMultiples.Base > 0 && finite(baseGrowth)
    ? solveIrr(currentPrice, currentAdjustedFcfPerShare, baseGrowth, secondStageGrowth, exitMultiples.Base, MODEL.reverseYears)
    : NaN;

  const currency = quote?.price?.currency || meta.currency || "USD";
  const marketCap = rawNumber(quote?.price?.marketCap) || currentPrice * currentShares;
  const company = quote?.price?.longName || quote?.price?.shortName || meta.longName || meta.shortName || ticker;
  const currentAssets = latestValue(balance(["CurrentAssets"]));
  const currentLiabilities = latestValue(balance(["CurrentLiabilities"]));
  const receivables = latestValue(balance(["Receivables", "AccountsReceivable"]));
  const averageAssets = meanRecent(balance(["TotalAssets"]));
  const averageEquity = meanRecent(balance(["StockholdersEquity", "CommonStockEquity"]));

  return {
    ticker, company, currency, prices, meta, seriesMap, quote, fundamentals,
    currentPrice, currentShares, marketCap, revenue, fcf, sbc, sbcSource, adjustedFcf,
    currentAdjustedFcfPerShare, currentMultiple, historicalCagrs, historicalBaseGrowth,
    analystRevenuePerShare, analystEps: analystEps > 0 ? analystEps : NaN,
    forwardRevenueGrowth, baseGrowth, growthScenarios, exitMultiples, scenarios,
    secondStageGrowth, baseTenYearCagr, reverseImpliedGrowth, baseImpliedIrr,
    metrics: {
      roe: safeDivide(netIncome, averageEquity),
      roa: safeDivide(netIncome, averageAssets),
      roic,
      adjustedFcfMargin: safeDivide(adjustedFcf, revenue),
      netMargin: safeDivide(netIncome, revenue),
      sbcMargin: safeDivide(sbc, revenue),
      shareCountCagr: seriesCagr(fundamentals, "shares"),
      netDebt,
      debtPerShare: safeDivide(totalDebt, currentShares),
      netDebtToEbitda: safeDivide(netDebt, ebitda),
      interestCoverage: safeDivide(operatingIncome, interestExpense),
      currentRatio: safeDivide(currentAssets, currentLiabilities),
      quickRatio: safeDivide(cash + receivables, currentLiabilities),
    },
  };
}

function utcDay(dateString) {
  return Date.parse(`${dateString}T00:00:00Z`) / 86400000;
}

function pchipEndpointSlope(h0, h1, slope0, slope1) {
  let derivative = ((2 * h0 + h1) * slope0 - h0 * slope1) / (h0 + h1);
  if (Math.sign(derivative) !== Math.sign(slope0)) {
    derivative = 0;
  } else if (
    Math.sign(slope0) !== Math.sign(slope1)
    && Math.abs(derivative) > Math.abs(3 * slope0)
  ) {
    derivative = 3 * slope0;
  }
  return derivative;
}

function createPchipInterpolator(rows, field, carryBeforeFirst = false) {
  const unique = new Map(
    rows
      .filter((row) => row.date && finite(row[field]))
      .map((row) => [row.date, row]),
  );
  const clean = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (!clean.length) return () => NaN;

  const x = clean.map((row) => utcDay(row.date));
  const y = clean.map((row) => row[field]);
  if (clean.length === 1) {
    return (targetDate) => {
      const target = utcDay(targetDate);
      return target >= x[0] || carryBeforeFirst ? y[0] : NaN;
    };
  }

  const h = x.slice(0, -1).map((value, index) => x[index + 1] - value);
  const segmentSlopes = h.map((width, index) => (y[index + 1] - y[index]) / width);
  const derivatives = new Array(clean.length).fill(0);
  if (clean.length === 2) {
    derivatives[0] = segmentSlopes[0];
    derivatives[1] = segmentSlopes[0];
  } else {
    derivatives[0] = pchipEndpointSlope(h[0], h[1], segmentSlopes[0], segmentSlopes[1]);
    derivatives[derivatives.length - 1] = pchipEndpointSlope(
      h.at(-1),
      h.at(-2),
      segmentSlopes.at(-1),
      segmentSlopes.at(-2),
    );
    for (let index = 1; index < clean.length - 1; index += 1) {
      const leftSlope = segmentSlopes[index - 1];
      const rightSlope = segmentSlopes[index];
      if (leftSlope === 0 || rightSlope === 0 || Math.sign(leftSlope) !== Math.sign(rightSlope)) {
        derivatives[index] = 0;
        continue;
      }
      const leftWeight = 2 * h[index] + h[index - 1];
      const rightWeight = h[index] + 2 * h[index - 1];
      derivatives[index] = (leftWeight + rightWeight)
        / (leftWeight / leftSlope + rightWeight / rightSlope);
    }
  }

  return (targetDate) => {
    const target = utcDay(targetDate);
    if (target < x[0]) return carryBeforeFirst ? y[0] : NaN;
    if (target >= x.at(-1)) return y.at(-1);

    let low = 0;
    let high = x.length - 1;
    while (high - low > 1) {
      const midpoint = Math.floor((low + high) / 2);
      if (x[midpoint] <= target) low = midpoint;
      else high = midpoint;
    }
    const width = h[low];
    const fraction = (target - x[low]) / width;
    const fraction2 = fraction * fraction;
    const fraction3 = fraction2 * fraction;
    return (
      (2 * fraction3 - 3 * fraction2 + 1) * y[low]
      + (fraction3 - 2 * fraction2 + fraction) * width * derivatives[low]
      + (-2 * fraction3 + 3 * fraction2) * y[low + 1]
      + (fraction3 - fraction2) * width * derivatives[low + 1]
    );
  };
}

function solveGrowth(currentPrice, fcfPerShare, requiredReturn, terminalMultiple, years) {
  const value = (growth) => {
    let presentValue = 0;
    for (let year = 1; year <= years; year += 1) {
      presentValue += fcfPerShare * (1 + growth) ** year / (1 + requiredReturn) ** year;
    }
    return presentValue + fcfPerShare * (1 + growth) ** years * terminalMultiple / (1 + requiredReturn) ** years;
  };
  let low = -0.5;
  let high = 0.5;
  if (value(low) >= currentPrice) return low;
  if (value(high) <= currentPrice) return high;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (value(midpoint) < currentPrice) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function twoStageValue(fcfPerShare, firstGrowth, secondGrowth, returnRate, terminalMultiple, years) {
  if (!(fcfPerShare > 0) || returnRate <= -1 || years < 2) return NaN;
  let futureFcf = fcfPerShare;
  let presentValue = 0;
  for (let year = 1; year <= years; year += 1) {
    futureFcf *= 1 + (year <= Math.floor(years / 2) ? firstGrowth : secondGrowth);
    presentValue += futureFcf / (1 + returnRate) ** year;
  }
  return presentValue + futureFcf * terminalMultiple / (1 + returnRate) ** years;
}

function solveIrr(currentPrice, fcfPerShare, firstGrowth, secondGrowth, terminalMultiple, years) {
  const value = (rate) => twoStageValue(fcfPerShare, firstGrowth, secondGrowth, rate, terminalMultiple, years);
  let low = -0.5;
  let high = 1;
  if (value(low) < currentPrice) return NaN;
  while (value(high) > currentPrice && high < 8) high *= 2;
  if (value(high) > currentPrice) return high;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (value(midpoint) > currentPrice) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function tooltipNumericValue(item) {
  const value = item?.value;
  return rawNumber(Array.isArray(value) ? value.at(-1) : value);
}

function tooltipDateLabel(item) {
  const rawValue = item?.axisValue ?? (Array.isArray(item?.value) ? item.value[0] : null);
  if (rawValue == null || rawValue === "") return "N/A";
  const date = new Date(rawValue);
  return Number.isNaN(date.getTime()) ? String(rawValue ?? "N/A") : date.toISOString().slice(0, 10);
}

function formatHoverTooltip(params, model, priceChart) {
  const entries = Array.isArray(params) ? params : [params];
  const actual = entries.find((item) => item?.seriesName === "Actual price");
  const datum = actual || entries.find((item) => finite(tooltipNumericValue(item)));
  const date = tooltipDateLabel(datum || entries[0]);
  if (!datum) return date;
  const value = tooltipNumericValue(datum);
  const valueText = priceChart
    ? formatMoney(value, model.currency, 2)
    : formatNumber(value, 1);
  return `${date}<br/>${priceChart ? "Price" : "Value"}: ${valueText}`;
}

function commonChartOption(model, yName) {
  const lastDate = model.prices.at(-1).date;
  const priceChart = yName.startsWith("Price");
  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { color: COLORS.text, fontFamily: "Inter, Noto Sans KR, sans-serif" },
    grid: { ...CHART_GRID, containLabel: false },
    legend: { top: 3, left: 4, textStyle: { color: "#aeb8bb", fontSize: 10 }, itemWidth: 16, itemHeight: 7 },
    tooltip: {
      trigger: "axis",
      axisPointer: {
        type: "cross",
        snap: true,
        lineStyle: { color: "#aeb8bb", width: 1, type: "dashed" },
        crossStyle: { color: "#aeb8bb", width: 1, type: "dashed" },
        label: {
          show: true,
          backgroundColor: "#263238",
          color: "#e7edef",
          fontSize: 10,
        },
      },
      backgroundColor: "rgba(3,6,7,0.96)",
      borderColor: "#4a5559",
      textStyle: { color: "#e7edef", fontSize: 11 },
      formatter: (params) => formatHoverTooltip(params, model, priceChart),
    },
    xAxis: {
      type: "time",
      min: new Date(yearStart(model.prices[0].date)).getTime(),
      max: new Date(addDays(addYears(lastDate, 1), 110)).getTime(),
      boundaryGap: false,
      axisLine: { lineStyle: { color: "#687277" } },
      axisTick: { lineStyle: { color: "#687277" } },
      axisLabel: { color: "#8f9a9e", fontSize: 10, hideOverlap: true, formatter: { year: "{yyyy}", month: "{MMM}" } },
      splitLine: { show: false },
      axisPointer: {
        show: true,
        type: "line",
        snap: true,
        triggerTooltip: true,
        lineStyle: { color: "#aeb8bb", width: 1, type: "dashed" },
      },
    },
    yAxis: {
      type: "value",
      name: yName,
      nameTextStyle: { color: "#919da1", fontSize: 10, padding: [0, 0, 0, 4] },
      scale: true,
      splitNumber: 16,
      axisLine: { show: true, lineStyle: { color: "#687277" } },
      axisLabel: { color: "#8f9a9e", fontSize: 9, hideOverlap: true },
      splitLine: { lineStyle: { color: COLORS.grid } },
      minorTick: { show: true, splitNumber: 4 },
      minorSplitLine: { show: true, lineStyle: { color: "rgba(122,122,122,0.08)", width: 0.6 } },
      axisPointer: {
        show: false,
      },
    },
    series: [],
  };
}

function actualPriceSeries(model) {
  return {
    name: "Actual price",
    type: "line",
    data: model.prices.map((row) => [row.date, row.value]),
    showSymbol: false,
    lineStyle: { color: COLORS.cyan, width: 1.5 },
    itemStyle: { color: COLORS.cyan },
    z: 10,
  };
}

function rgba(hex, alpha) {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
}

function valuationAreaSeries(name, lower, upper, color) {
  const rows = lower.map((item, index) => [item[0], item[1], upper[index]?.[1]]).filter((item) => finite(item[1]) && finite(item[2]));
  return {
    name,
    type: "custom",
    coordinateSystem: "cartesian2d",
    silent: true,
    data: rows.slice(0, -1),
    renderItem(params, api) {
      const index = params.dataIndex;
      const next = rows[index + 1];
      if (!next) return null;
      const p1 = api.coord([api.value(0), api.value(1)]);
      const p2 = api.coord([api.value(0), api.value(2)]);
      const p3 = api.coord([next[0], next[2]]);
      const p4 = api.coord([next[0], next[1]]);
      return { type: "polygon", shape: { points: [p1, p2, p3, p4] }, style: { fill: rgba(color, 0.085), stroke: "none" } };
    },
    z: 0,
  };
}

function renderFcfChart(model) {
  const option = commonChartOption(model, `Price (${model.currency})`);
  option.legend.show = false;
  const currentDate = model.prices.at(-1).date;
  const futureDate = addYears(currentDate, 1);
  const anchors = model.fundamentals.filter((row) => finite(row.adjustedFcfPerShare));
  if (finite(model.currentAdjustedFcfPerShare) && finite(model.baseGrowth)) {
    anchors.push({ date: futureDate, adjustedFcfPerShare: model.currentAdjustedFcfPerShare * (1 + model.baseGrowth) });
  }
  const fcfSpline = createPchipInterpolator(anchors, "adjustedFcfPerShare", true);
  const dates = model.prices.map((row) => row.date);
  for (let cursor = addDays(currentDate, 7); cursor <= futureDate; cursor = addDays(cursor, 7)) dates.push(cursor);
  if (!dates.includes(futureDate)) dates.push(futureDate);
  const uniqueDates = [...new Set(dates)].sort();
  const paths = MODEL.yields.map((yieldValue) => uniqueDates.map((date) => {
    const driver = fcfSpline(date);
    return [date, driver > 0 ? driver / yieldValue : NaN];
  }));
  for (let index = 0; index < paths.length - 1; index += 1) {
    option.series.push(valuationAreaSeries(`${MODEL.yields[index] * 100}-${MODEL.yields[index + 1] * 100}% area`, paths[index + 1], paths[index], YIELD_COLORS[index + 1]));
  }
  option.series.push(actualPriceSeries(model));
  paths.forEach((path, index) => option.series.push({
    name: `${Math.round(MODEL.yields[index] * 100)}% yield`,
    type: "line",
    data: path,
    showSymbol: false,
    smooth: BAND_SMOOTH,
    smoothMonotone: "x",
    connectNulls: false,
    lineStyle: { color: YIELD_COLORS[index], width: 1.05, type: "dashed" },
    itemStyle: { color: YIELD_COLORS[index] },
    endLabel: { show: true, formatter: `${Math.round(MODEL.yields[index] * 100)}%`, color: YIELD_COLORS[index], fontSize: 10 },
    labelLayout: { moveOverlap: "shiftY" },
    z: 4,
  }));
  const grays = { Bear: "#8f8f8f", Base: "#b5b5b5", Bull: "#d0d0d0" };
  for (const name of ["Bear", "Base", "Bull"]) {
    const scenario = model.scenarios[name];
    if (!finite(scenario.targetPrice)) continue;
    option.series.push({
      name: `${name} 1Y`,
      type: "line",
      data: [[currentDate, model.currentPrice], [futureDate, scenario.targetPrice]],
      smooth: 0.32,
      showSymbol: true,
      symbolSize: 5,
      lineStyle: { color: grays[name], width: 1, opacity: 0.78 },
      itemStyle: { color: grays[name] },
      endLabel: {
        show: true,
        formatter: `${name} ${formatPercent(scenario.totalReturn, 1, true)}`,
        color: grays[name],
        fontSize: 10,
        distance: 28,
      },
      labelLayout: { moveOverlap: "shiftY" },
      z: 2,
    });
  }
  option.series.push({
    name: "Today",
    type: "line",
    data: [],
    markLine: { silent: true, symbol: "none", lineStyle: { color: "#ffffff", type: "dotted", opacity: 0.55 }, label: { show: false }, data: [{ xAxis: currentDate }] },
  });
  setChart("fcf-chart", option);
  const currentYield = safeDivide(model.adjustedFcf, model.marketCap);
  setCaption("fcf-caption", [
    ["Current FCF-SBC yield", formatPercent(currentYield)],
    ["Current FCF-SBC/share", formatMoney(model.currentAdjustedFcfPerShare, model.currency)],
    ["Analyst +1Y Rev/share avg", `${formatMoney(model.analystRevenuePerShare, model.currency)} (${forwardChange(model.fundamentals.at(-1)?.revenuePerShare, model.analystRevenuePerShare)})`],
  ]);
}

function calculateValuationBand(model, field, analystDriver) {
  const anchors = model.fundamentals.filter((row) => finite(row[field]));
  const historicalSpline = createPchipInterpolator(anchors, field, true);
  const historical = model.prices.map((row) => {
    const driver = historicalSpline(row.date);
    return { date: row.date, price: row.value, driver, multiple: driver > 0 ? row.value / driver : NaN };
  });
  const rawMultiples = historical.map((row) => row.multiple).filter((value) => finite(value) && value > 0);
  const multipleCap = field === "eps" ? MODEL.maxPeMultiple : NaN;
  const multiples = finite(multipleCap)
    ? rawMultiples.filter((value) => value <= multipleCap)
    : rawMultiples;
  const excludedCount = rawMultiples.length - multiples.length;
  const currentDate = model.prices.at(-1).date;
  const currentDriver = historicalSpline(currentDate);
  if (multiples.length < 30) {
    return {
      historical,
      levels: [],
      paths: [],
      currentDriver,
      multipleCap,
      excludedCount,
    };
  }
  const low = quantile(multiples, 0.05);
  const high = quantile(multiples, 0.95);
  const clipped = multiples.map((value) => clamp(value, low, high));
  const levels = [0.10, 0.25, 0.50, 0.75, 0.90].map((q) => quantile(clipped, q));
  const futureDate = addYears(currentDate, 1);
  let projectionDrivers = [];
  if (analystDriver > 0 && currentDriver > 0) {
    const projectionAnchors = [
      ...anchors,
      { date: currentDate, [field]: currentDriver },
      { date: futureDate, [field]: analystDriver },
    ];
    const projectionSpline = createPchipInterpolator(projectionAnchors, field, true);
    for (let date = addDays(currentDate, 7); date < futureDate; date = addDays(date, 7)) {
      projectionDrivers.push([date, projectionSpline(date)]);
    }
    projectionDrivers.push([futureDate, analystDriver]);
  }
  const paths = levels.map((level) => {
    const path = historical.map((row) => [row.date, row.driver > 0 ? row.driver * level : NaN]);
    if (projectionDrivers.length) {
      path.push(...projectionDrivers.map(([date, driver]) => [date, driver * level]));
    } else if (analystDriver > 0) {
      path.push([currentDate, NaN], [futureDate, analystDriver * level]);
    }
    return path;
  });
  return { historical, levels, paths, currentDriver, multipleCap, excludedCount };
}

function renderMultipleChart(model, elementId, captionId, field, name, analystDriver, analystLabel) {
  const calculation = calculateValuationBand(model, field, analystDriver);
  const option = commonChartOption(model, `Price (${model.currency})`);
  option.legend.show = false;
  if (calculation.levels.length === 5) {
    for (let index = 0; index < 4; index += 1) {
      option.series.push(valuationAreaSeries(`${name} area`, calculation.paths[index], calculation.paths[index + 1], BAND_COLORS[index + 1]));
    }
    calculation.paths.forEach((path, index) => option.series.push({
      name: `${name} q${[10, 25, 50, 75, 90][index]} · ${calculation.levels[index].toFixed(1)}x`,
      type: "line",
      data: path,
      showSymbol: false,
      smooth: BAND_SMOOTH,
      smoothMonotone: "x",
      connectNulls: false,
      lineStyle: { color: BAND_COLORS[index], width: 1, type: "dashed" },
      itemStyle: { color: BAND_COLORS[index] },
      endLabel: { show: true, formatter: `${calculation.levels[index].toFixed(1)}x`, color: BAND_COLORS[index], fontSize: 10 },
      labelLayout: { moveOverlap: "shiftY" },
      z: 3,
    }));
  }
  option.series.push(actualPriceSeries(model));
  option.series.push({
    name: "Today", type: "line", data: [],
    markLine: { silent: true, symbol: "none", lineStyle: { color: "#fff", type: "dotted", opacity: 0.55 }, label: { show: false }, data: [{ xAxis: model.prices.at(-1).date }] },
  });
  if (!calculation.levels.length) {
    option.graphic = [{ type: "text", left: "center", top: "middle", style: { text: `${name} bands: N/A\nFewer than 30 positive observations`, fill: "#aab4b7", font: "12px sans-serif", textAlign: "center", lineHeight: 20 } }];
  }
  setChart(elementId, option);
  const currentMultiple = calculation.currentDriver > 0 ? model.currentPrice / calculation.currentDriver : NaN;
  const captionEntries = [
    [`Current ${name}`, formatMultiple(currentMultiple)],
    ["Historical median", formatMultiple(calculation.levels[2])],
    [analystLabel, `${formatMoney(analystDriver, model.currency)} (${forwardChange(calculation.currentDriver, analystDriver)})`],
  ];
  if (finite(calculation.multipleCap)) {
    captionEntries.push([
      "PER band rule",
      `>${formatMultiple(calculation.multipleCap, 0)} excluded (${calculation.excludedCount} days)`,
    ]);
  }
  setCaption(captionId, captionEntries);
}

function normalizedSeries(rows, field) {
  const clean = rows.filter((row) => finite(row[field]));
  if (!clean.length) return [];
  const firstAbs = Math.abs(clean[0][field]);
  const maxAbs = Math.max(...clean.map((row) => Math.abs(row[field])), 1);
  const scale = firstAbs > 0 && maxAbs / firstAbs <= 5 ? firstAbs : maxAbs;
  return clean.map((row) => [row.date, row[field] / scale * 100]);
}

function renderFundamentalsChart(model) {
  const option = commonChartOption(model, "Indexed level");
  option.legend.show = false;
  option.grid.right = 68;
  option.yAxis.splitNumber = 6;
  option.yAxis.axisLabel = {
    ...option.yAxis.axisLabel,
    formatter: (value) => Math.round(value),
  };
  option.yAxis.minorTick = { show: false };
  option.yAxis.minorSplitLine = { show: false };
  option.yAxis = [option.yAxis, {
    type: "value", name: "ROIC", position: "right", scale: true, splitNumber: 4,
    nameTextStyle: { color: COLORS.purple, fontSize: 10 },
    axisLine: { show: true, lineStyle: { color: COLORS.purple } },
    axisLabel: { color: COLORS.purple, formatter: (value) => `${Math.round(value)}%`, fontSize: 9, hideOverlap: true },
    splitLine: { show: false },
    minorTick: { show: false },
    minorSplitLine: { show: false },
    axisPointer: { show: false },
  }];
  const definitions = [
    ["Revenue/share", "revenuePerShare", COLORS.cyan],
    ["FCF-SBC/share", "adjustedFcfPerShare", COLORS.green],
    ["GAAP EPS/share", "eps", COLORS.yellow],
    ["Shares", "shares", "#657075"],
  ];
  option.series = definitions.map(([name, field, color]) => ({
    name, type: "line", data: normalizedSeries(model.fundamentals, field),
    showSymbol: true, symbolSize: 5, smooth: 0.24,
    lineStyle: { color, width: 1.5 }, itemStyle: { color },
    endLabel: {
      show: true,
      formatter: (params) => `${name} ${formatNumber(tooltipNumericValue(params), 0)}${name === "Shares" ? " ↓ better" : ""}`,
      color,
      fontSize: 10,
      distance: 8,
      align: "left",
      offset: [0, 0],
      backgroundColor: "rgba(5,8,9,0.86)",
      padding: [2, 4],
    },
    labelLayout: { moveOverlap: "shiftY" },
  }));
  option.series.push({
    name: "ROIC", type: "line", yAxisIndex: 1,
    data: model.fundamentals.filter((row) => finite(row.roic)).map((row) => [row.date, row.roic * 100]),
    showSymbol: true, symbolSize: 5, smooth: 0.24,
    lineStyle: { color: COLORS.purple, width: 1.5 }, itemStyle: { color: COLORS.purple },
    endLabel: {
      show: true,
      formatter: (params) => `ROIC ${formatNumber(tooltipNumericValue(params), 1)}%`,
      color: COLORS.purple,
      fontSize: 10,
      distance: 8,
      align: "left",
      offset: [0, 0],
      backgroundColor: "rgba(5,8,9,0.86)",
      padding: [2, 4],
    },
    labelLayout: { moveOverlap: "shiftY" },
  });
  setChart("fundamentals-chart", option);
  setCaption("fundamentals-caption", [
    ["Revenue/share CAGR", formatPercent(model.historicalCagrs.revenue)],
    ["FCF-SBC/share CAGR", formatPercent(model.historicalCagrs.adjustedFcf)],
    ["GAAP EPS CAGR", formatPercent(model.historicalCagrs.eps)],
    ["Shares CAGR", formatPercent(model.metrics.shareCountCagr, 1, true)],
  ]);
}

function forwardChange(current, future) {
  return current > 0 && future > 0 ? formatPercent(future / current - 1, 1, true) : "N/A";
}

function setCaption(id, entries) {
  document.querySelector(`#${id}`).innerHTML = entries.map(([label, value]) =>
    `<span class="caption-chip">${escapeHtml(label)}: <strong>${escapeHtml(value)}</strong></span>`
  ).join("");
}

function renderMetrics(model) {
  setMetrics("profitability-metrics", [
    ["ROE", formatPercent(model.metrics.roe)],
    ["ROA", formatPercent(model.metrics.roa)],
    ["ROIC", formatPercent(model.metrics.roic)],
    ["WACC", formatPercent(MODEL.requiredReturn)],
    ["FCF-SBC margin", formatPercent(model.metrics.adjustedFcfMargin)],
    ["Net margin", formatPercent(model.metrics.netMargin)],
    ["SBC margin", formatPercent(model.metrics.sbcMargin)],
    ["Share-count CAGR", formatPercent(model.metrics.shareCountCagr, 1, true)],
  ]);
  setMetrics("balance-metrics", [
    ["Net debt", formatCompactMoney(model.metrics.netDebt, model.currency)],
    ["Debt / Share", formatMoney(model.metrics.debtPerShare, model.currency)],
    ["Net debt / EBITDA", formatMultiple(model.metrics.netDebtToEbitda, 2)],
    ["Interest coverage", formatMultiple(model.metrics.interestCoverage)],
    ["Current ratio", formatMultiple(model.metrics.currentRatio, 2)],
    ["Quick ratio", formatMultiple(model.metrics.quickRatio, 2)],
  ]);
  setMetrics("reverse-metrics", [
    ["Implied 10Y FCF-SBC growth", formatPercent(model.reverseImpliedGrowth), "cyan"],
    ["Base implied IRR", formatPercent(model.baseImpliedIrr), "yellow"],
    ["Base 10Y FCF-SBC CAGR", formatPercent(model.baseTenYearCagr)],
    ["Base minus implied", finite(model.baseTenYearCagr) && finite(model.reverseImpliedGrowth) ? `${formatPercent(model.baseTenYearCagr - model.reverseImpliedGrowth, 1, true)}p` : "N/A", "green"],
    ["Year-10 P/(FCF-SBC)", formatMultiple(model.exitMultiples.Base)],
  ]);
}

function setMetrics(id, entries) {
  document.querySelector(`#${id}`).innerHTML = entries.map(([label, value, color = ""]) =>
    `<dt title="${escapeHtml(label)}">${escapeHtml(label)}</dt><dd class="${color}">${escapeHtml(value)}</dd>`
  ).join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[character]);
}

function chartGridRect(chart) {
  const coordinateRect = chart.getModel?.().getComponent?.("grid", 0)?.coordinateSystem?.getRect?.();
  if (coordinateRect && [coordinateRect.x, coordinateRect.y, coordinateRect.width, coordinateRect.height].every(finite)) {
    return coordinateRect;
  }
  return {
    x: CHART_GRID.left,
    y: CHART_GRID.top,
    width: Math.max(0, chart.getWidth() - CHART_GRID.left - CHART_GRID.right),
    height: Math.max(0, chart.getHeight() - CHART_GRID.top - CHART_GRID.bottom),
  };
}

function installHorizontalCrosshair(chart) {
  if (typeof chart.getZr !== "function" || chart.__horizontalCrosshairInstalled) return;
  chart.__horizontalCrosshairInstalled = true;
  const zr = chart.getZr();
  let pendingY = NaN;
  let frameId = null;

  const setGraphic = (invisible, y = NaN) => {
    const rect = chartGridRect(chart);
    chart.setOption({
      graphic: [{
        id: HORIZONTAL_CROSSHAIR_ID,
        type: "line",
        shape: {
          x1: rect.x,
          y1: y,
          x2: rect.x + rect.width,
          y2: y,
        },
        style: { stroke: "#aeb8bb", lineWidth: 1, lineDash: [5, 4] },
        invisible,
        silent: true,
        z: 100,
      }],
    }, { lazyUpdate: true });
  };

  const flush = () => {
    frameId = null;
    if (finite(pendingY)) setGraphic(false, pendingY);
  };

  const schedule = () => {
    if (frameId !== null) return;
    const requestFrame = window.requestAnimationFrame || ((callback) => window.setTimeout(callback, 0));
    frameId = requestFrame(flush);
  };

  zr.on("mousemove", (event) => {
    const x = finite(event?.zrX) ? event.zrX : rawNumber(event?.offsetX);
    const y = finite(event?.zrY) ? event.zrY : rawNumber(event?.offsetY);
    if (!finite(x) || !finite(y)) return;
    const rect = chartGridRect(chart);
    if (x < rect.x || x > rect.x + rect.width || y < rect.y || y > rect.y + rect.height) {
      pendingY = NaN;
      setGraphic(true);
      return;
    }
    pendingY = clamp(y, rect.y, rect.y + rect.height);
    schedule();
  });

  zr.on("globalout", () => {
    pendingY = NaN;
    setGraphic(true);
  });
}

function setChart(id, option) {
  if (!window.echarts) throw new Error("ECharts failed to load from the CDN.");
  let chart = chartInstances.get(id);
  if (!chart) {
    chart = window.echarts.init(document.getElementById(id), null, { renderer: "canvas" });
    chartInstances.set(id, chart);
    installHorizontalCrosshair(chart);
  }
  chart.clear();
  chart.setOption(option, { notMerge: true });
}

function renderDashboard(model, payload, responseStatus, elapsedMs) {
  dom.title.textContent = `${model.company} (${model.ticker})`;
  dom.marketSummary.textContent = `${formatMoney(model.currentPrice, model.currency)} · Market cap ${formatCompactMoney(model.marketCap, model.currency)} · ${model.prices.at(-1).date}`;
  dom.dashboard.hidden = false;
  renderFcfChart(model);
  renderMultipleChart(model, "per-chart", "per-caption", "eps", "PER", model.analystEps, "Analyst +1Y EPS/share avg");
  renderMultipleChart(model, "psr-chart", "psr-caption", "revenuePerShare", "PSR", model.analystRevenuePerShare, "Analyst +1Y Revenue/share avg");
  renderFundamentalsChart(model);
  renderMetrics(model);
  const endpointSummary = Object.fromEntries(Object.entries(payload.data || {}).map(([name, item]) => [name, {
    status: item.status,
    ok: item.ok,
    attempts: item.attempts,
    waitedMs: item.waitedMs,
    error: item.error,
    auth: item.auth,
  }]));
  dom.diagnostic.textContent = JSON.stringify({
    ticker: model.ticker,
    httpStatus: responseStatus,
    elapsedMs,
    source: payload.source,
    requestPlan: payload.requestPlan,
    endpointSummary,
    model: {
      currentAdjustedFcfPerShare: model.currentAdjustedFcfPerShare,
      sbcSource: model.sbcSource,
      historicalCagrs: model.historicalCagrs,
      forwardRevenueGrowth: model.forwardRevenueGrowth,
      baseGrowth: model.baseGrowth,
      growthScenarios: model.growthScenarios,
      exitMultiples: model.exitMultiples,
      valuationCaps: { maxPeMultiple: MODEL.maxPeMultiple },
      scenarios: model.scenarios,
      reverseImpliedGrowth: model.reverseImpliedGrowth,
      baseImpliedIrr: model.baseImpliedIrr,
    },
  }, null, 2);
}

function normalizeWorkerUrl(value) {
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol)) throw new Error("Worker URL must use http or https.");
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function tickerValue(value) {
  const ticker = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9.^=-]{0,14}$/.test(ticker)) throw new Error("Ticker 형식이 올바르지 않습니다.");
  return ticker;
}

function setStatus(kind, message, elapsed = "") {
  dom.statusDot.className = `status-dot ${kind}`;
  dom.statusText.textContent = message;
  dom.elapsed.textContent = elapsed;
}

function setLoading(loading) {
  dom.button.disabled = loading;
  dom.button.classList.toggle("loading", loading);
  dom.ticker.disabled = loading;
  dom.workerUrl.disabled = loading;
}

async function analyze(event) {
  event.preventDefault();
  const started = performance.now();
  try {
    const ticker = tickerValue(dom.ticker.value);
    const workerUrl = normalizeWorkerUrl(dom.workerUrl.value);
    localStorage.setItem("stockDashboardWorkerUrl", workerUrl);
    const endpoint = `${workerUrl}/api/stock?symbol=${encodeURIComponent(ticker)}`;
    setLoading(true);
    setStatus("loading", `${ticker}: Worker가 Yahoo 데이터를 순차 조회하는 중…`);
    const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Worker returned non-JSON data (HTTP ${response.status}).`);
    }
    if (!payload?.data) throw new Error(payload?.error || `Invalid Worker response (HTTP ${response.status}).`);
    const model = buildDashboardModel(payload, ticker);
    const elapsed = performance.now() - started;
    renderDashboard(model, payload, response.status, Math.round(elapsed));
    const failed = Object.entries(payload.data).filter(([, item]) => !item.ok).map(([name, item]) =>
      `${name}${item.status ? ` HTTP ${item.status}` : ""}`
    );
    const quoteAuth = payload.data.quote?.auth;
    if (failed.length) {
      setStatus("warning", `${ticker}: 표시 완료 · 일부 endpoint 실패 (${failed.join(", ")})`, `${(elapsed / 1000).toFixed(1)}s`);
    } else if (quoteAuth?.refreshedAfter401) {
      setStatus("success", `${ticker}: dashboard ready · Yahoo session refreshed after 401`, `${(elapsed / 1000).toFixed(1)}s`);
    } else {
      const sessionText = quoteAuth?.session === "reused" ? " · Yahoo session reused" : "";
      setStatus("success", `${ticker}: dashboard ready${sessionText}`, `${(elapsed / 1000).toFixed(1)}s`);
    }
    history.replaceState(null, "", `${location.pathname}?ticker=${encodeURIComponent(ticker)}&worker=${encodeURIComponent(workerUrl)}`);
  } catch (error) {
    const elapsed = performance.now() - started;
    setStatus("error", error instanceof Error ? error.message : String(error), `${(elapsed / 1000).toFixed(1)}s`);
    dom.diagnostic.textContent = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack || ""}` : String(error);
  } finally {
    setLoading(false);
  }
}

function initializeInputs() {
  const query = new URLSearchParams(location.search);
  const queryTicker = query.get("ticker");
  if (queryTicker) dom.ticker.value = queryTicker.toUpperCase();
  const queryWorker = query.get("worker");
  const storedWorker = localStorage.getItem("stockDashboardWorkerUrl");
  const localDefault = location.protocol === "file:" || ["localhost", "127.0.0.1"].includes(location.hostname)
    ? "http://127.0.0.1:8787"
    : "";
  dom.workerUrl.value = queryWorker || storedWorker || localDefault;
}

let resizeFrame = null;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => chartInstances.forEach((chart) => chart.resize()));
});
dom.form.addEventListener("submit", analyze);
dom.ticker.addEventListener("input", () => { dom.ticker.value = dom.ticker.value.toUpperCase(); });
initializeInputs();
