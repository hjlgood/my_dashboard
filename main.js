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
  price: "#00e5e5",
  revenue: "#6f9fd8",
  fcf: "#78b69f",
  eps: "#c7ae78",
  shares: "#778387",
  roic: "#aa9abb",
});

const BAND_COLORS = ["#637c86", "#77949e", "#d6dfe2", "#9a8d7d", "#7c6d63"];
const BAND_LINE_TYPES = ["dotted", "dashed", "solid", "dashed", "dotted"];
const BAND_SMOOTH = 0.80;
const NUMERIC_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const CHART_GRID = Object.freeze({ left: 74, right: 84, top: 42, bottom: 56 });
const RETURN_RAIL = Object.freeze({ minimumMagnitude: 0.50, step: 0.25, maximumMagnitude: 2.00 });
const ENDPOINT_IMPACTS = Object.freeze({
  chart: "Price history and charts 1–3",
  fundamentals: "Chart 4 and historical drivers",
  quote: "Masthead, current price and metrics",
  analysis: "Valuation rail, bands and scenarios",
});
const HORIZONTAL_CROSSHAIR_ID = "manual-horizontal-crosshair";
const chartInstances = new Map();
const chartPointerStates = new Map();

const dom = {
  form: document.querySelector("#stock-form"),
  ticker: document.querySelector("#ticker-input"),
  workerUrl: document.querySelector("#worker-url-input"),
  workerSettings: document.querySelector("#worker-settings"),
  button: document.querySelector("#analyze-button"),
  statusDot: document.querySelector("#status-dot"),
  statusText: document.querySelector("#status-text"),
  elapsed: document.querySelector("#elapsed-text"),
  loadingDetail: document.querySelector("#loading-detail"),
  mobileIdentityTicker: document.querySelector("#mobile-identity-ticker"),
  mobileIdentityPrice: document.querySelector("#mobile-identity-price"),
  railDataNotice: document.querySelector("#rail-data-notice"),
  railDataNoticeText: document.querySelector("#rail-data-notice-text"),
  railHealthDetails: document.querySelector("#rail-health-details"),
  savePngButton: document.querySelector("#save-png-button"),
  saveHtmlButton: document.querySelector("#save-html-button"),
  exportStatus: document.querySelector("#export-status"),
  title: document.querySelector("#company-title"),
  marketSummary: document.querySelector("#market-summary"),
  dashboard: document.querySelector("#dashboard"),
  diagnostic: document.querySelector("#diagnostic-output"),
  coordinateTooltip: document.querySelector("#coordinate-tooltip"),
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
  const analystPriceTarget = rawNumber(quote?.financialData?.targetMeanPrice);
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
    analystRevenuePerShare,
    analystEps: analystEps > 0 ? analystEps : NaN,
    analystPriceTarget: analystPriceTarget > 0 ? analystPriceTarget : NaN,
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

function formatAxisDate(value) {
  const numeric = rawNumber(value);
  const date = finite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? "N/A") : date.toISOString().slice(0, 10);
}

function formatAxisPrice(value, model) {
  return formatMoney(rawNumber(value), model.currency, 2);
}

function formatCompactAxisPrice(value, model) {
  const numeric = rawNumber(value);
  if (!finite(numeric)) return "N/A";
  const symbol = currencySymbol(model.currency);
  const absolute = Math.abs(numeric);
  if (absolute >= 1000) {
    const digits = absolute >= 10000 ? 0 : 1;
    return `${symbol}${(numeric / 1000).toFixed(digits)}k`;
  }
  return `${symbol}${absolute >= 100 ? Math.round(numeric) : numeric.toFixed(absolute < 10 ? 1 : 0)}`;
}

function formatHoverTooltip(params, model, priceChart, chartId, coordinateTooltip) {
  const entries = Array.isArray(params) ? params : [params];
  const actual = entries.find((item) => item?.seriesName === "Actual price");
  const datum = actual || entries.find((item) => finite(tooltipNumericValue(item)));
  const pointer = coordinateTooltip ? chartPointerStates.get(chartId) : null;
  const date = finite(pointer?.xValue)
    ? formatAxisDate(pointer.xValue)
    : tooltipDateLabel(datum || entries[0]);
  const value = finite(pointer?.yValue) ? pointer.yValue : tooltipNumericValue(datum);
  if (!datum && !finite(value)) return date;
  const valueText = priceChart
    ? formatAxisPrice(value, model)
    : formatNumber(value, 1);
  return `${date}<br/>${priceChart ? "Price" : "Value"}: ${valueText}`;
}

function endLabelAtLineInside(offsetX = 8) {
  return (params) => {
    const lineRect = params.rect || params.labelRect;
    const labelRect = params.labelRect || { y: lineRect.y, height: 0 };
    return {
      x: lineRect.x + lineRect.width - offsetX,
      y: labelRect.y + labelRect.height / 2,
      align: "right",
      verticalAlign: "middle",
      moveOverlap: "shiftY",
      hideOverlap: false,
    };
  };
}

function endLabelAtLineRight(offsetX = 8) {
  return (params) => {
    const lineRect = params.rect || params.labelRect;
    const labelRect = params.labelRect || { y: lineRect.y, height: 0 };
    return {
      x: lineRect.x + lineRect.width + offsetX,
      y: labelRect.y + labelRect.height / 2,
      align: "left",
      verticalAlign: "middle",
      moveOverlap: "shiftY",
      hideOverlap: false,
    };
  };
}

function commonChartOption(model, yName, chartId = null, coordinateTooltip = false) {
  const lastDate = model.prices.at(-1).date;
  const priceChart = yName.startsWith("Price");
  return {
    animation: false,
    backgroundColor: "transparent",
    textStyle: { color: COLORS.text, fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" },
    grid: { ...CHART_GRID, containLabel: false },
    legend: { top: 3, left: 4, textStyle: { color: "#c3ced0", fontSize: 11 }, itemWidth: 16, itemHeight: 7 },
    tooltip: {
      trigger: "axis",
      showContent: !coordinateTooltip,
      axisPointer: {
        type: "cross",
        snap: true,
        lineStyle: { color: "#aeb8bb", width: 1, type: "dashed" },
        crossStyle: { color: "#aeb8bb", width: 1, type: "dashed" },
        label: {
          show: true,
          backgroundColor: "#263238",
          color: "#e7edef",
          fontSize: 11,
          fontFamily: NUMERIC_FONT,
        },
      },
      backgroundColor: "rgba(3,6,7,0.96)",
      borderColor: "#4a5559",
      textStyle: { color: "#e7edef", fontSize: 12 },
      formatter: (params) => formatHoverTooltip(params, model, priceChart, chartId, coordinateTooltip),
    },
    xAxis: {
      type: "time",
      min: new Date(yearStart(model.prices[0].date)).getTime(),
      max: new Date(addDays(addYears(lastDate, 1), 110)).getTime(),
      boundaryGap: false,
      axisLine: { lineStyle: { color: "#687277" } },
      axisTick: { lineStyle: { color: "#687277" } },
      axisLabel: { color: "#b2bec1", fontSize: 11, fontFamily: NUMERIC_FONT, hideOverlap: true, formatter: { year: "{yyyy}", month: "{MMM}" } },
      splitLine: { show: false },
      axisPointer: {
        show: true,
        type: "line",
        snap: coordinateTooltip ? false : true,
        triggerTooltip: true,
        ...(coordinateTooltip ? {
          label: {
            show: true,
            formatter: (params) => formatAxisDate(params.value),
            backgroundColor: "#263238",
            color: "#e7edef",
            fontSize: 11,
            fontFamily: NUMERIC_FONT,
          },
        } : {}),
        lineStyle: { color: "#aeb8bb", width: 1, type: "dashed" },
      },
    },
    yAxis: {
      type: "value",
      name: yName,
      nameTextStyle: { color: "#b2bec1", fontSize: 11, padding: [0, 0, 0, 4] },
      scale: true,
      splitNumber: 6,
      axisLine: { show: true, lineStyle: { color: "#687277" } },
      axisLabel: {
        color: "#b2bec1",
        fontSize: 11,
        fontFamily: NUMERIC_FONT,
        hideOverlap: true,
        ...(priceChart ? { formatter: (value) => formatCompactAxisPrice(value, model) } : {}),
      },
      splitLine: { lineStyle: { color: COLORS.grid } },
      minorTick: { show: false },
      minorSplitLine: { show: false },
      axisPointer: coordinateTooltip ? {
        show: true,
        type: "line",
        snap: false,
        triggerTooltip: true,
        label: {
          show: true,
          formatter: (params) => formatAxisPrice(params.value, model),
          backgroundColor: "#263238",
          color: "#e7edef",
          fontSize: 11,
          fontFamily: NUMERIC_FONT,
        },
        lineStyle: { color: "#aeb8bb", width: 1, type: "dashed" },
      } : {
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
    lineStyle: { color: COLORS.price, width: 1.9 },
    itemStyle: { color: COLORS.price },
    z: 10,
  };
}

function rgba(hex, alpha) {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
}

function bandAreaFill(topColor, bottomColor = topColor) {
  if (window.echarts?.graphic?.LinearGradient) {
    return new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: rgba(topColor, 0.09) },
      { offset: 1, color: rgba(bottomColor, 0.09) },
    ]);
  }
  return rgba(topColor, 0.09);
}

function valuationAreaSeries(name, lower, upper, topColor, bottomColor = topColor) {
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
      return { type: "polygon", shape: { points: [p1, p2, p3, p4] }, style: { fill: bandAreaFill(topColor, bottomColor), stroke: "none" } };
    },
    z: 0,
  };
}

function setInsight(id, entries) {
  const element = document.querySelector(`#${id}`);
  if (!element) return;
  const usable = Array.isArray(entries) ? entries.filter((entry) => Array.isArray(entry) && entry.length >= 2) : [];
  element.innerHTML = usable.map(([label, value]) =>
    `<span class="insight-token"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`
  ).join("");
  element.hidden = !usable.length;
}

function markerPosition(value, low, high) {
  if (!finite(value) || !finite(low) || !finite(high) || high <= low) return NaN;
  return clamp((value - low) / (high - low) * 100, 6, 94);
}

function formatRailReturn(value) {
  return finite(value) ? formatPercent(value, 1, true) : "N/A";
}

function setValuationVerdict(model) {
  const element = document.querySelector("#rail-verdict");
  if (!element) return;
  const baseReturn = model.scenarios.Base?.totalReturn;
  const baseIrr = model.baseImpliedIrr;
  const returnMessage = finite(baseReturn)
    ? `Base case ${formatPercent(baseReturn, 1, true)} 1Y return`
    : "Base case 1Y output unavailable";
  const irrMessage = !finite(baseIrr)
    ? "10Y IRR unavailable"
    : `10Y IRR ${formatPercent(baseIrr)} · ${baseIrr >= MODEL.requiredReturn ? "clears" : "below"} ${formatPercent(MODEL.requiredReturn, 0)} hurdle`;
  const positive = finite(baseReturn) && baseReturn >= 0.05 && finite(baseIrr) && baseIrr >= MODEL.requiredReturn;
  const negative = finite(baseReturn) && baseReturn < 0 && finite(baseIrr) && baseIrr < MODEL.requiredReturn;
  element.className = `rail-verdict ${positive ? "verdict-positive" : negative ? "verdict-negative" : "verdict-caution"}`;
  const verdictCopy = document.createElement("span");
  verdictCopy.className = "rail-verdict-copy";
  const primary = document.createElement("strong");
  primary.className = "rail-verdict-primary";
  primary.textContent = returnMessage;
  const secondary = document.createElement("span");
  secondary.className = "rail-verdict-secondary";
  secondary.textContent = irrMessage;
  verdictCopy.append(primary, secondary);
  element.replaceChildren(verdictCopy);
}

function adaptiveReturnRail(values) {
  const largestMagnitude = Math.max(
    RETURN_RAIL.minimumMagnitude,
    ...values.filter(finite).map((value) => Math.abs(value)),
  );
  const paddedMagnitude = largestMagnitude + RETURN_RAIL.step * 0.08;
  const magnitude = Math.min(
    RETURN_RAIL.maximumMagnitude,
    Math.ceil(paddedMagnitude / RETURN_RAIL.step) * RETURN_RAIL.step,
  );
  return { low: -magnitude, high: magnitude };
}

function dataCoverageChecks(model) {
  const latestPriceDate = model.prices.at(-1)?.date;
  const latestPriceTime = latestPriceDate ? new Date(`${latestPriceDate}T00:00:00Z`).getTime() : NaN;
  const ageDays = finite(latestPriceTime) ? Math.max(0, Math.floor((Date.now() - latestPriceTime) / 86400000)) : NaN;
  const baselineFields = ["revenuePerShare", "adjustedFcfPerShare", "eps", "shares"];
  const baselineDate = findCommonBaselineDate(model.fundamentals, baselineFields);
  const hasEpsEstimate = model.analystEps > 0;
  const hasRevenueEstimate = model.analystRevenuePerShare > 0;
  const estimateDetail = hasEpsEstimate && hasRevenueEstimate
    ? "EPS and revenue/share estimates available"
    : hasEpsEstimate
      ? "EPS available · revenue/share missing"
      : hasRevenueEstimate
        ? "Revenue/share available · EPS missing"
        : "EPS and revenue/share estimates missing";
  return [
    {
      name: "Price coverage",
      detail: latestPriceDate
        ? `${model.prices.length} observations · through ${latestPriceDate}${finite(ageDays) ? ` · ${ageDays}d old` : ""}`
        : "Price history unavailable",
      impact: "Current price and charts 1–3",
      ok: model.prices.length >= 30 && finite(ageDays) && ageDays <= 7,
    },
    {
      name: "Fundamentals",
      detail: `${model.fundamentals.length} periods · ${baselineDate ? `common baseline ${baselineDate}` : "per-series fallback"}`,
      impact: "Chart 4 and historical valuation drivers",
      ok: model.fundamentals.length >= 5 && Boolean(baselineDate),
    },
    {
      name: "Analyst estimates",
      detail: estimateDetail,
      impact: "Forward PER and PSR regions",
      ok: hasEpsEstimate && hasRevenueEstimate,
    },
    {
      name: "SBC treatment",
      detail: model.sbcSource || "Unavailable",
      impact: "FCF-SBC yield, scenarios and implied IRR",
      ok: model.sbcSource === "latest four quarters",
    },
  ];
}

function renderValuationRail(model, payload) {
  const currentYield = safeDivide(model.adjustedFcf, model.marketCap);
  const endpointEntries = Object.entries(payload.data || {});
  const endpoints = endpointEntries.map(([, item]) => item);
  const successfulEndpoints = endpoints.filter((item) => item?.ok).length;
  const totalEndpoints = endpoints.length;

  const formattedPrice = formatMoney(model.currentPrice, model.currency);
  document.querySelector("#rail-context").textContent = model.ticker;
  document.querySelector("#rail-current-price").textContent = formattedPrice;
  document.querySelector("#rail-current-yield").textContent = formatPercent(currentYield);
  document.querySelector("#rail-base-irr").textContent = formatPercent(model.baseImpliedIrr);
  if (dom.mobileIdentityTicker) dom.mobileIdentityTicker.textContent = model.ticker;
  if (dom.mobileIdentityPrice) dom.mobileIdentityPrice.textContent = formattedPrice;
  const coverageChecks = dataCoverageChecks(model);
  const healthElement = document.querySelector("#rail-data-health");
  const failedEndpoints = endpointEntries.filter(([, item]) => !item?.ok);
  const coverageWarnings = coverageChecks.filter((item) => !item.ok);
  const warningCount = failedEndpoints.length + coverageWarnings.length + (totalEndpoints ? 0 : 1);
  setValuationVerdict(model);
  const warningReasons = [
    ...failedEndpoints.map(([name, item]) => `${name} endpoint${item?.status ? ` · HTTP ${item.status}` : " · failed"}`),
    ...coverageWarnings.map((item) => `${item.name} · ${item.detail}`),
  ];
  if (dom.railDataNotice && dom.railDataNoticeText) {
    const reason = warningReasons.slice(0, 2).join(" · ") || "source status unavailable";
    dom.railDataNotice.hidden = warningCount === 0;
    dom.railDataNotice.classList.toggle("is-warning", warningCount > 0);
    dom.railDataNoticeText.textContent = warningCount > 0
      ? `${warningCount} data warning${warningCount === 1 ? "" : "s"} · ${reason}`
      : "All source and coverage checks passed";
    dom.railDataNotice.title = warningReasons.join(" · ") || "All source and coverage checks passed";
    dom.railDataNotice.setAttribute("aria-expanded", "false");
  }
  healthElement.textContent = warningCount ? `${warningCount} warning${warningCount === 1 ? "" : "s"}` : "Healthy";
  healthElement.classList.toggle("rail-health-warning", warningCount > 0);
  document.querySelector("#rail-health-summary").textContent = warningCount
    ? `${warningCount} source or coverage warning${warningCount === 1 ? "" : "s"}. Review the affected views below.`
    : `All ${successfulEndpoints} endpoints and model coverage checks are healthy.`;
  document.querySelector("#rail-health-list").innerHTML = endpointEntries.length ? endpointEntries.map(([name, item]) => {
    const status = item?.ok ? "OK" : item?.status ? `HTTP ${item.status}` : "Failed";
    const statusClass = item?.ok ? "" : " class=\"endpoint-failed\"";
    const impact = ENDPOINT_IMPACTS[name] || "Dependent dashboard data";
    return `<li><span><span class="endpoint-name">${escapeHtml(name)}</span><small>Impact: ${escapeHtml(impact)}</small></span><strong${statusClass}>${escapeHtml(status)}</strong></li>`;
  }).join("") : "<li><span><span class=\"endpoint-name\">Unavailable</span><small>Impact: Source status cannot be verified</small></span><strong class=\"endpoint-failed\">Check</strong></li>";
  document.querySelector("#rail-coverage-list").innerHTML = coverageChecks.map((item) => {
    const statusClass = item.ok ? "" : " class=\"endpoint-failed\"";
    return `<li><span><span class="endpoint-name">${escapeHtml(item.name)}</span><small>${escapeHtml(item.detail)} · Impact: ${escapeHtml(item.impact)}</small></span><strong${statusClass}>${item.ok ? "OK" : "Review"}</strong></li>`;
  }).join("");

  const markers = [
    { id: "rail-current-marker", valueId: "rail-current-track-value", label: "Current", value: 0, targetPrice: model.currentPrice, current: true },
    { id: "rail-bear-marker", valueId: "rail-bear-value", label: "Bear", value: model.scenarios.Bear?.totalReturn, targetPrice: model.scenarios.Bear?.targetPrice },
    { id: "rail-base-marker", valueId: "rail-base-value", label: "Base", value: model.scenarios.Base?.totalReturn, targetPrice: model.scenarios.Base?.targetPrice },
    { id: "rail-bull-marker", valueId: "rail-bull-value", label: "Bull", value: model.scenarios.Bull?.totalReturn, targetPrice: model.scenarios.Bull?.targetPrice },
  ];
  const usableValues = markers.map((marker) => marker.value).filter(finite);
  const track = document.querySelector("#valuation-track");
  if (usableValues.length < 2) {
    track.classList.add("valuation-track-empty");
    track.setAttribute("aria-label", "One-year valuation scenarios are unavailable.");
    markers.forEach((marker) => { document.querySelector(`#${marker.id}`).hidden = true; });
    return;
  }

  track.classList.remove("valuation-track-empty");
  const railRange = adaptiveReturnRail(usableValues);
  document.querySelector("#valuation-track-range").textContent =
    `Scenario returns · adaptive ${formatPercent(railRange.low, 0, true)} to ${formatPercent(railRange.high, 0, true)}`;
  document.querySelector("#valuation-track-tick-low").textContent = formatPercent(railRange.low, 0, true);
  document.querySelector("#valuation-track-tick-high").textContent = formatPercent(railRange.high, 0, true);
  const positionedTargets = [];
  for (const marker of markers) {
    const markerElement = document.querySelector(`#${marker.id}`);
    const valueElement = document.querySelector(`#${marker.valueId}`);
    markerElement.hidden = !finite(marker.value);
    valueElement.textContent = formatRailReturn(marker.value);
    if (!finite(marker.value)) continue;
    const position = markerPosition(marker.value, railRange.low, railRange.high);
    markerElement.style.left = `${position}%`;
    markerElement.classList.toggle("rail-marker-edge-left", position < 12);
    markerElement.classList.toggle("rail-marker-edge-right", position > 88);
    markerElement.classList.toggle("rail-marker-overflow-low", marker.value < railRange.low);
    markerElement.classList.toggle("rail-marker-overflow-high", marker.value > railRange.high);
    markerElement.title = `${marker.label}: ${formatMoney(marker.targetPrice, model.currency)} (${formatRailReturn(marker.value)})`;
    if (!marker.current) positionedTargets.push({ markerElement, position });
  }

  positionedTargets.sort((left, right) => left.position - right.position);
  let previousPosition = -Infinity;
  let previousLane = 0;
  for (const target of positionedTargets) {
    const lane = target.position - previousPosition < 15 ? 1 - previousLane : 0;
    target.markerElement.style.setProperty("--lane", lane);
    previousPosition = target.position;
    previousLane = lane;
  }

  const scenarioDescription = markers.filter((marker) => finite(marker.value))
    .map((marker) => `${marker.label} ${formatRailReturn(marker.value)}`)
    .join(", ");
  track.setAttribute("aria-label", `One-year valuation rail using an adaptive ${formatRailReturn(railRange.low)} to ${formatRailReturn(railRange.high)} return range: ${scenarioDescription}.`);
}

function renderFcfChart(model) {
  const option = commonChartOption(model, `Price (${model.currency})`, "fcf-chart", true);
  const compact = window.innerWidth <= 760;
  const veryCompact = window.innerWidth <= 470;
  option.grid.left = veryCompact ? 50 : compact ? 62 : CHART_GRID.left;
  option.grid.right = veryCompact ? 28 : compact ? 32 : 36;
  if (veryCompact) {
    option.yAxis.name = "";
    option.yAxis.axisLabel.formatter = (value) => formatCompactAxisPrice(value, model);
    option.xAxis.splitNumber = 4;
    option.xAxis.axisLabel.formatter = (value) => String(new Date(value).getUTCFullYear());
  }
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
  // Higher FCF yields produce lower implied prices, so reverse the shared
  // palette to keep the vertical color order consistent with PER/PSR.
  const fcfBandColors = [...BAND_COLORS].reverse();
  for (let index = 0; index < paths.length - 1; index += 1) {
    option.series.push(valuationAreaSeries(
      `${MODEL.yields[index] * 100}-${MODEL.yields[index + 1] * 100}% area`,
      paths[index + 1],
      paths[index],
      fcfBandColors[index],
      fcfBandColors[index + 1],
    ));
  }
  option.series.push(actualPriceSeries(model));
  paths.forEach((path, index) => {
    option.series.push({
      name: `${Math.round(MODEL.yields[index] * 100)}% yield`,
      type: "line",
      data: path,
      showSymbol: false,
      smooth: BAND_SMOOTH,
      smoothMonotone: "x",
      connectNulls: false,
      lineStyle: {
        color: fcfBandColors[index],
        width: 1.15,
        type: "solid",
        opacity: 0.88,
      },
      itemStyle: { color: fcfBandColors[index] },
      endLabel: {
        show: path.some(([, value]) => finite(value)),
        formatter: `${Math.round(MODEL.yields[index] * 100)}%`,
        color: fcfBandColors[index],
        fontSize: veryCompact ? 8 : compact ? 9 : 11,
        fontWeight: 600,
      },
      labelLayout: endLabelAtLineRight(veryCompact ? 4 : compact ? 6 : 8),
      z: 4,
    });
  });
  const scenarioStyles = {
    Bear: { color: "#d77d70", type: "dotted", opacity: 0.78, symbol: "triangle" },
    Base: { color: "#dce4e6", type: "solid", opacity: 0.96, symbol: "circle" },
    Bull: { color: "#78b69f", type: "dashed", opacity: 0.82, symbol: "diamond" },
  };
  for (const name of ["Bear", "Base", "Bull"]) {
    const scenario = model.scenarios[name];
    if (!finite(scenario.targetPrice)) continue;
    const scenarioStyle = scenarioStyles[name];
    option.series.push({
      name: `${name} 1Y`,
      type: "line",
      data: [[currentDate, model.currentPrice], [futureDate, scenario.targetPrice]],
      smooth: 0.32,
      showSymbol: true,
      symbol: scenarioStyle.symbol,
      symbolSize: name === "Base" ? 6 : 7,
      lineStyle: { color: scenarioStyle.color, width: name === "Base" ? 1.5 : 1.2, type: scenarioStyle.type, opacity: scenarioStyle.opacity },
      itemStyle: { color: scenarioStyle.color },
      endLabel: {
        show: finite(scenario.targetPrice),
        formatter: veryCompact ? name : `${name} ${formatPercent(scenario.totalReturn, 1, true)}`,
        color: scenarioStyle.color,
        fontSize: veryCompact ? 8 : compact ? 9 : 11,
        fontWeight: 600,
      },
      labelLayout: endLabelAtLineInside(veryCompact ? 42 : compact ? 56 : 72),
      z: 2,
    });
  }
  option.series.push({
    name: "Today",
    type: "line",
    data: [],
    markLine: { silent: true, symbol: "none", lineStyle: { color: "#ffffff", type: "dotted", opacity: 0.55 }, label: { show: false }, data: [{ xAxis: currentDate }] },
  });
  setChart("fcf-chart", option, { model, priceChart: true, coordinateTooltip: true });
  const baseReturn = model.scenarios.Base?.totalReturn;
  setInsight("fcf-insight", [
    ["Base 1Y return", formatPercent(baseReturn, 1, true)],
  ]);
  setCaption("fcf-caption", [
    ["Current FCF-SBC/share", formatMoney(model.currentAdjustedFcfPerShare, model.currency)],
    ["Analyst 1Y Price Target/share", `${formatMoney(model.analystPriceTarget, model.currency)} (${forwardChange(model.currentPrice, model.analystPriceTarget)})`],
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
  const option = commonChartOption(model, `Price (${model.currency})`, elementId, true);
  const compact = window.innerWidth <= 760;
  const veryCompact = window.innerWidth <= 470;
  option.grid.left = veryCompact ? 50 : compact ? 62 : CHART_GRID.left;
  option.grid.right = veryCompact ? 56 : compact ? 62 : 70;
  if (veryCompact) {
    option.yAxis.name = "";
    option.yAxis.axisLabel.formatter = (value) => formatCompactAxisPrice(value, model);
    option.xAxis.splitNumber = 4;
    option.xAxis.axisLabel.formatter = (value) => String(new Date(value).getUTCFullYear());
  }
  option.legend.show = false;
  if (calculation.levels.length === 5) {
    for (let index = 0; index < 4; index += 1) {
      option.series.push(valuationAreaSeries(
        `${name} area`,
        calculation.paths[index],
        calculation.paths[index + 1],
        BAND_COLORS[index + 1],
        BAND_COLORS[index],
      ));
    }
    calculation.paths.forEach((path, index) => {
      const isMedian = index === 2;
      option.series.push({
        name: `${name} q${[10, 25, 50, 75, 90][index]} · ${calculation.levels[index].toFixed(1)}x`,
        type: "line",
        data: path,
        showSymbol: false,
        smooth: BAND_SMOOTH,
        smoothMonotone: "x",
        connectNulls: false,
        lineStyle: {
          color: BAND_COLORS[index],
          width: isMedian ? 1.7 : 1,
          type: BAND_LINE_TYPES[index],
          opacity: isMedian ? 1 : 0.78,
        },
        itemStyle: { color: BAND_COLORS[index] },
        endLabel: {
          show: true,
          formatter: `${isMedian ? "Median" : `P${[10, 25, 50, 75, 90][index]}`} ${calculation.levels[index].toFixed(1)}x`,
          color: isMedian ? "#f0f5f6" : BAND_COLORS[index],
          fontSize: isMedian ? (veryCompact ? 9 : compact ? 10 : 11) : (veryCompact ? 8 : compact ? 9 : 10),
          fontWeight: 500,
        },
        labelLayout: isMedian
          ? endLabelAtLineInside(veryCompact ? 4 : compact ? 6 : 8)
          : endLabelAtLineRight(veryCompact ? 4 : compact ? 6 : 8),
        z: isMedian ? 4 : 3,
      });
    });
  }
  option.series.push(actualPriceSeries(model));
  option.series.push({
    name: "Today", type: "line", data: [],
    markLine: {
      silent: true,
      symbol: "none",
      lineStyle: { color: "#aeb8bb", type: "dotted", opacity: 0.55 },
      data: [
        {
          xAxis: model.prices.at(-1).date,
          label: { show: true, formatter: "Today", position: "insideStartTop", rotate: 0, color: "#aeb8bb", fontSize: 10, fontFamily: NUMERIC_FONT },
        },
        {
          xAxis: addYears(model.prices.at(-1).date, 1),
          lineStyle: { color: "#8fb4bf", type: "dashed", opacity: 0.72 },
          label: { show: true, formatter: "1Y forward", position: "insideEndTop", rotate: 0, color: "#b6cbd1", fontSize: 10, fontFamily: NUMERIC_FONT },
        },
      ],
    },
  });
  if (!calculation.levels.length) {
    option.graphic = [{ type: "text", left: "center", top: "middle", style: { text: `${name} bands: N/A\nFewer than 30 positive observations`, fill: "#aab4b7", font: "12px sans-serif", textAlign: "center", lineHeight: 20 } }];
  }
  setChart(elementId, option, { model, priceChart: true, coordinateTooltip: true });
  const currentMultiple = calculation.currentDriver > 0 ? model.currentPrice / calculation.currentDriver : NaN;
  const historicalMedian = calculation.levels[2];
  const insightId = `${elementId.replace("-chart", "")}-insight`;
  if (finite(currentMultiple) && finite(historicalMedian) && historicalMedian > 0) {
    const medianDifference = currentMultiple / historicalMedian - 1;
    const driverChange = calculation.currentDriver > 0 && analystDriver > 0
      ? analystDriver / calculation.currentDriver - 1
      : NaN;
    const driverName = field === "eps" ? "EPS/share" : "Revenue/share";
    setInsight(insightId, [
      [`Current ${name}`, formatMultiple(currentMultiple)],
      ["vs historical median", formatPercent(medianDifference, 1, true)],
      [`1Y forward ${driverName}`, formatPercent(driverChange, 1, true)],
    ]);
  } else {
    setInsight(insightId, [
      [`Historical ${name}`, "Unavailable"],
      ["Band rule", "<30 positive observations"],
    ]);
  }
  const captionEntries = [
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

function findCommonBaselineDate(rows, fields) {
  return rows.find((row) => row.date && fields.every((field) => finite(row[field]) && Math.abs(row[field]) > 1e-9))?.date || null;
}

function normalizedSeries(rows, field, baselineDate = null) {
  const clean = rows.filter((row) => finite(row[field]));
  if (!clean.length) return [];
  const baselineIndex = baselineDate
    ? clean.findIndex((row) => row.date === baselineDate && Math.abs(row[field]) > 1e-9)
    : clean.findIndex((row) => Math.abs(row[field]) > 1e-9);
  if (baselineIndex < 0) return [];
  const baseline = clean[baselineIndex][field];
  return clean.slice(baselineIndex).map((row) => {
    const indexedValue = baseline > 0
      ? row[field] / baseline * 100
      : 100 + (row[field] - baseline) / Math.abs(baseline) * 100;
    return [row.date, indexedValue];
  });
}

function renderFundamentalsChart(model) {
  const option = commonChartOption(model, "Indexed change", "fundamentals-chart");
  const compact = window.innerWidth <= 760;
  const veryCompact = window.innerWidth <= 470;
  option.grid.left = veryCompact ? 48 : compact ? 60 : CHART_GRID.left;
  option.legend.show = false;
  option.grid.top = 36;
  option.grid.right = veryCompact ? 52 : compact ? 64 : 72;
  if (veryCompact) {
    option.xAxis.splitNumber = 4;
    option.xAxis.axisLabel.formatter = (value) => String(new Date(value).getUTCFullYear());
  }
  option.yAxis.splitNumber = 4;
  option.yAxis.axisLabel = {
    ...option.yAxis.axisLabel,
    formatter: (value) => Math.round(value),
  };
  option.yAxis.minorTick = { show: false };
  option.yAxis.minorSplitLine = { show: false };
  option.yAxis = [option.yAxis, {
    type: "value", name: "ROIC", position: "right", scale: true, splitNumber: 3,
    nameTextStyle: { color: COLORS.roic, fontSize: 12, fontWeight: 700 },
    axisLine: { show: true, lineStyle: { color: COLORS.roic } },
    axisLabel: { color: COLORS.roic, formatter: (value) => `${Math.round(value)}%`, fontSize: 11, fontFamily: NUMERIC_FONT, hideOverlap: true },
    splitLine: { show: false },
    minorTick: { show: false },
    minorSplitLine: { show: false },
    axisPointer: { show: false },
  }];
  const definitions = [
    ["Revenue/share", "revenuePerShare", COLORS.revenue],
    ["FCF-SBC/share", "adjustedFcfPerShare", COLORS.fcf],
    ["GAAP EPS/share", "eps", COLORS.eps],
    ["Shares", "shares", COLORS.shares],
  ];
  const baselineDate = findCommonBaselineDate(model.fundamentals, definitions.map(([, field]) => field));
  option.series = definitions.map(([name, field, color]) => {
    const data = normalizedSeries(model.fundamentals, field, baselineDate);
    const latestValue = data.at(-1)?.[1];
    return {
      name, type: "line", data,
      showSymbol: true, symbolSize: 4, smooth: 0.24,
      lineStyle: { color, width: 1.15, opacity: 0.68 }, itemStyle: { color, opacity: 0.82 },
      endLabel: {
        show: data.length > 0,
        formatter: `${name} ${formatNumber(latestValue, 0)}`,
        color,
        fontSize: veryCompact ? 8 : compact ? 9 : 11,
        fontWeight: 600,
        distance: 8,
        align: "left",
      },
      labelLayout: endLabelAtLineRight(veryCompact ? 4 : compact ? 6 : 8),
    };
  });
  const roicData = model.fundamentals
    .filter((row) => (!baselineDate || row.date >= baselineDate) && finite(row.roic))
    .map((row) => [row.date, row.roic * 100]);
  const latestRoic = roicData.at(-1)?.[1];
  option.series.push({
    name: "ROIC", type: "line", yAxisIndex: 1,
    data: roicData,
    showSymbol: true, symbolSize: 6, smooth: 0.24,
    lineStyle: { color: COLORS.roic, width: 2.3, opacity: 1 }, itemStyle: { color: COLORS.roic },
    endLabel: {
      show: roicData.length > 0,
      formatter: `ROIC ${formatNumber(latestRoic, 1)}%`,
      color: COLORS.roic,
      fontSize: veryCompact ? 8 : compact ? 9 : 11,
      fontWeight: 750,
      distance: 8,
      align: "left",
    },
    labelLayout: endLabelAtLineRight(veryCompact ? 4 : compact ? 6 : 8),
  });
  setChart("fundamentals-chart", option, { model, priceChart: false, coordinateTooltip: false });
  const methodElement = document.querySelector("#fundamentals-method");
  if (methodElement) {
    methodElement.textContent = baselineDate
      ? `Common baseline: ${baselineDate} = 100 · ROIC = right axis`
      : "Each series = first non-zero period · ROIC = right axis";
  }
  setInsight("fundamentals-insight", [
    ["Latest ROIC", formatPercent(model.metrics.roic)],
    ["Indexed baseline", baselineDate || "Per-series fallback"],
  ]);
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
  document.querySelector(`#${id}`).innerHTML = entries.map(([label, value]) => {
    const safeLabel = escapeHtml(label);
    const safeValue = escapeHtml(value);
    return `<span class="caption-metric" title="${safeLabel}: ${safeValue}"><span class="caption-label">${safeLabel}</span><strong>${safeValue}</strong></span>`;
  }).join("");
}

let html2CanvasPromise = null;
let exportStatusTimer = null;
let exportBusy = false;

function setExportStatus(message, state = "") {
  if (!dom.exportStatus) return;
  if (exportStatusTimer) {
    clearTimeout(exportStatusTimer);
    exportStatusTimer = null;
  }
  dom.exportStatus.textContent = message;
  if (state) dom.exportStatus.dataset.state = state;
  else delete dom.exportStatus.dataset.state;
  if (message && state === "success") {
    exportStatusTimer = setTimeout(() => setExportStatus(""), 5000);
  }
}

function updateExportButtonState() {
  const disabled = exportBusy || dom.button?.classList.contains("loading");
  [dom.savePngButton, dom.saveHtmlButton].forEach((button) => {
    if (!button) return;
    button.disabled = disabled;
    button.setAttribute("aria-busy", String(exportBusy));
  });
}

function setExportBusy(busy) {
  exportBusy = busy;
  updateExportButtonState();
}

function loadHtml2Canvas() {
  if (typeof window.html2canvas === "function") return Promise.resolve(window.html2canvas);
  if (html2CanvasPromise) return html2CanvasPromise;
  html2CanvasPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
    script.async = true;
    script.dataset.exportLibrary = "html2canvas";
    script.onload = () => typeof window.html2canvas === "function"
      ? resolve(window.html2canvas)
      : reject(new Error("PNG export library did not load."));
    script.onerror = () => reject(new Error("PNG export library could not be loaded."));
    document.head.append(script);
  });
  return html2CanvasPromise;
}

function exportFileStem() {
  const ticker = (dom.ticker?.value || "dashboard").trim().toUpperCase()
    .replace(/[^A-Z0-9.^=-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "dashboard";
  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
  return `${ticker}-dashboard-${date}`;
}

function downloadBlob(blob, filename) {
  if (!(blob instanceof Blob)) throw new Error("Export did not produce a file.");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function replaceDashboardCanvasesWithImages() {
  const replacements = [...document.querySelectorAll("canvas")].map((canvas) => {
    const image = document.createElement("img");
    [...canvas.attributes].forEach((attribute) => image.setAttribute(attribute.name, attribute.value));
    image.style.cssText = canvas.style.cssText;
    image.alt = canvas.closest("[aria-label]")?.getAttribute("aria-label") || "Chart";
    image.src = canvas.toDataURL("image/png");
    canvas.replaceWith(image);
    return { canvas, image };
  });
  return () => replacements.forEach(({ canvas, image }) => image.replaceWith(canvas));
}

async function withExportLayout(callback) {
  const body = document.body;
  const previous = {
    exporting: body.classList.contains("is-exporting"),
    condensed: body.classList.contains("mobile-dock-condensed"),
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
  const details = [...document.querySelectorAll("details")];
  const detailStates = details.map((detailsElement) => detailsElement.open);
  body.classList.add("is-exporting");
  body.classList.remove("mobile-dock-condensed");
  details.forEach((detailsElement) => { detailsElement.open = false; });
  window.scrollTo(0, 0);
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  try {
    return await callback();
  } finally {
    body.classList.toggle("is-exporting", previous.exporting);
    body.classList.toggle("mobile-dock-condensed", previous.condensed);
    details.forEach((detailsElement, index) => { detailsElement.open = detailStates[index]; });
    window.scrollTo(previous.scrollX, previous.scrollY);
    scheduleMobileDockUpdate();
  }
}

async function saveDashboardPng() {
  if (!document.body.classList.contains("dashboard-ready")) return;
  setExportBusy(true);
  setExportStatus("Preparing PNG…", "loading");
  try {
    const html2canvas = await loadHtml2Canvas();
    const blob = await withExportLayout(async () => {
      const width = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const height = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const restoreCharts = replaceDashboardCanvasesWithImages();
      try {
        const canvas = await html2canvas(document.body, {
          backgroundColor: "#050708",
          logging: false,
          useCORS: true,
          scale: Math.min(2, Math.max(1, window.devicePixelRatio || 1)),
          width,
          height,
          windowWidth: document.documentElement.clientWidth,
          windowHeight: document.documentElement.clientHeight,
          scrollX: 0,
          scrollY: 0,
          ignoreElements: (element) => element.id === "coordinate-tooltip"
            || element.classList?.contains("export-tools")
            || element.classList?.contains("worker-field")
            || element.classList?.contains("rail-health-popover"),
          onclone: (clonedDocument) => {
            [...clonedDocument.querySelectorAll("*")].forEach((element) => {
              if (clonedDocument.defaultView.getComputedStyle(element).backgroundImage === "none") return;
              element.style.setProperty("background-image", "none", "important");
              if (element.classList.contains("valuation-track-line")) element.style.backgroundColor = "#829095";
            });
          },
        });
        return canvasToBlob(canvas);
      } finally {
        restoreCharts();
      }
    });
    const filename = `${exportFileStem()}.png`;
    downloadBlob(blob, filename);
    setExportStatus(`Downloaded ${filename}`, "success");
  } catch (error) {
    console.error("PNG export failed", error);
    setExportStatus(error instanceof Error ? error.message : "PNG export failed.", "error");
  } finally {
    setExportBusy(false);
  }
}

async function snapshotStylesheet() {
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  const fetched = [];
  for (const link of links) {
    try {
      const response = await fetch(link.href, { cache: "no-store" });
      if (response.ok) fetched.push(await response.text());
    } catch {
      // Fall back to CSSOM below for file:// pages or restricted origins.
    }
  }
  if (fetched.length) return fetched.join("\n");
  return [...document.styleSheets].flatMap((sheet) => {
    try {
      return [...sheet.cssRules].map((rule) => rule.cssText);
    } catch {
      return [];
    }
  }).join("\n");
}

async function createDashboardSnapshot() {
  const stylesheet = await snapshotStylesheet();
  const sourceCanvases = [...document.querySelectorAll("canvas")];
  const snapshot = document.documentElement.cloneNode(true);
  const snapshotCanvases = [...snapshot.querySelectorAll("canvas")];
  snapshotCanvases.forEach((canvas, index) => {
    const image = document.createElement("img");
    [...canvas.attributes].forEach((attribute) => image.setAttribute(attribute.name, attribute.value));
    try {
      image.src = sourceCanvases[index]?.toDataURL("image/png") || "";
    } catch {
      image.alt = "Chart image unavailable";
    }
    image.alt ||= canvas.closest("[aria-label]")?.getAttribute("aria-label") || "Chart";
    image.style.display = "block";
    canvas.replaceWith(image);
  });

  const sourceControls = [...document.querySelectorAll("input, textarea, select")];
  const snapshotControls = [...snapshot.querySelectorAll("input, textarea, select")];
  snapshotControls.forEach((control, index) => {
    const source = sourceControls[index];
    if (!source) return;
    if (control instanceof HTMLSelectElement) {
      [...control.options].forEach((option, optionIndex) => option.toggleAttribute("selected", optionIndex === source.selectedIndex));
    } else if (control.type === "checkbox" || control.type === "radio") {
      control.toggleAttribute("checked", source.checked);
    } else {
      control.setAttribute("value", source.value);
    }
  });

  const sourceDetails = [...document.querySelectorAll("details")];
  const snapshotDetails = [...snapshot.querySelectorAll("details")];
  snapshotDetails.forEach((details, index) => details.toggleAttribute("open", Boolean(sourceDetails[index]?.open)));
  snapshot.querySelectorAll("script, link[rel=\"stylesheet\"], .export-tools, #coordinate-tooltip, .worker-field, .rail-health-popover").forEach((element) => element.remove());
  snapshot.querySelector("body")?.classList.remove("is-exporting");
  const inlineStyle = document.createElement("style");
  inlineStyle.setAttribute("data-snapshot-source", "style.css");
  inlineStyle.textContent = stylesheet;
  snapshot.querySelector("head")?.append(inlineStyle);
  const title = snapshot.querySelector("title");
  if (title) title.textContent = `${document.title} — static render`;
  return `<!doctype html>\n${snapshot.outerHTML}`;
}

async function saveDashboardHtml() {
  if (!document.body.classList.contains("dashboard-ready")) return;
  setExportBusy(true);
  setExportStatus("Preparing HTML…", "loading");
  try {
    const html = await withExportLayout(() => createDashboardSnapshot());
    const filename = `${exportFileStem()}.html`;
    downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), filename);
    setExportStatus(`Downloaded ${filename}`, "success");
  } catch (error) {
    console.error("HTML export failed", error);
    setExportStatus(error instanceof Error ? error.message : "HTML export failed.", "error");
  } finally {
    setExportBusy(false);
  }
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
    ["Implied 10Y FCF-SBC growth", formatPercent(model.reverseImpliedGrowth), "data-blue"],
    ["Base implied IRR", formatPercent(model.baseImpliedIrr)],
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

function updateChartPointerState(chart, chartId, x, y) {
  if (!chartId || typeof chart.convertFromPixel !== "function") return;
  const dataPoint = chart.convertFromPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [x, y]);
  if (!Array.isArray(dataPoint)) return;
  const previous = chartPointerStates.get(chartId) || {};
  const next = { ...previous, pixelX: x, pixelY: y };
  const xValue = rawNumber(dataPoint[0]);
  const yValue = rawNumber(dataPoint[1]);
  if (finite(xValue)) next.xValue = xValue;
  if (finite(yValue)) next.yValue = yValue;
  chartPointerStates.set(chartId, next);
}

function hideCoordinateTooltip() {
  if (!dom.coordinateTooltip) return;
  dom.coordinateTooltip.hidden = true;
  dom.coordinateTooltip.setAttribute("aria-hidden", "true");
  dom.coordinateTooltip.style.left = "-9999px";
  dom.coordinateTooltip.style.top = "-9999px";
}

function showCoordinateTooltip(chart, chartId, x, y) {
  const element = dom.coordinateTooltip;
  const context = chart.__coordinateTooltipContext;
  if (!element || !context?.coordinateTooltip || typeof chart.convertFromPixel !== "function") return;
  const dataPoint = chart.convertFromPixel({ xAxisIndex: 0, yAxisIndex: 0 }, [x, y]);
  const xValue = rawNumber(dataPoint?.[0]);
  const yValue = rawNumber(dataPoint?.[1]);
  if (!finite(xValue) || !finite(yValue)) return;
  chartPointerStates.set(chartId, { ...(chartPointerStates.get(chartId) || {}), pixelX: x, pixelY: y, xValue, yValue });

  const valueText = context.priceChart
    ? formatAxisPrice(yValue, context.model)
    : formatNumber(yValue, 1);
  element.innerHTML = `<span class="coordinate-tooltip-label">${escapeHtml(formatAxisDate(xValue))}</span><br>Price <strong>${escapeHtml(valueText)}</strong>`;
  element.hidden = false;
  element.setAttribute("aria-hidden", "false");

  const rect = chart.getDom().getBoundingClientRect();
  const offset = 14;
  const viewportPadding = 8;
  const requestedLeft = rect.left + x + offset;
  const requestedTop = rect.top + y + offset;
  const left = clamp(requestedLeft, viewportPadding, Math.max(viewportPadding, window.innerWidth - element.offsetWidth - viewportPadding));
  const top = clamp(requestedTop, viewportPadding, Math.max(viewportPadding, window.innerHeight - element.offsetHeight - viewportPadding));
  element.style.left = `${left}px`;
  element.style.top = `${top}px`;
}

function installHorizontalCrosshair(chart, chartId = null) {
  if (typeof chart.getZr !== "function" || chart.__horizontalCrosshairInstalled) return;
  chart.__horizontalCrosshairInstalled = true;
  const zr = chart.getZr();
  let pendingY = NaN;
  let frameId = null;

  if (chartId && typeof chart.on === "function") {
    chart.on("updateAxisPointer", (event) => {
      const axesInfo = Array.isArray(event?.axesInfo) ? event.axesInfo : [];
      const xAxisInfo = axesInfo.find((info) => info.axisDim === "x" && info.axisIndex === 0);
      const yAxisInfo = axesInfo.find((info) => info.axisDim === "y" && info.axisIndex === 0);
      const previous = chartPointerStates.get(chartId) || {};
      const next = { ...previous };
      const xValue = xAxisInfo?.value == null ? NaN : rawNumber(xAxisInfo.value);
      const yValue = yAxisInfo?.value == null ? NaN : rawNumber(yAxisInfo.value);
      if (finite(xValue)) next.xValue = xValue;
      if (finite(yValue)) next.yValue = yValue;
      if (finite(next.xValue) || finite(next.yValue)) chartPointerStates.set(chartId, next);
    });
  }

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
      if (chartId) chartPointerStates.delete(chartId);
      hideCoordinateTooltip();
      setGraphic(true);
      return;
    }
    updateChartPointerState(chart, chartId, x, y);
    showCoordinateTooltip(chart, chartId, x, y);
    pendingY = clamp(y, rect.y, rect.y + rect.height);
    schedule();
  });

  zr.on("globalout", () => {
    pendingY = NaN;
    if (chartId) chartPointerStates.delete(chartId);
    hideCoordinateTooltip();
    setGraphic(true);
  });
}

function setChart(id, option, context = null) {
  if (!window.echarts) throw new Error("ECharts failed to load from the CDN.");
  let chart = chartInstances.get(id);
  if (!chart) {
    chart = window.echarts.init(document.getElementById(id), null, { renderer: "canvas" });
    chartInstances.set(id, chart);
    chart.__coordinateTooltipContext = context;
    installHorizontalCrosshair(chart, id);
  } else {
    chart.__coordinateTooltipContext = context;
  }
  chartPointerStates.delete(id);
  hideCoordinateTooltip();
  chart.clear();
  chart.setOption(option, { notMerge: true });
}

function installDashboardNavigation() {
  const navigation = document.querySelector(".section-nav");
  if (!navigation || navigation.__dashboardNavigationInstalled) return;
  navigation.__dashboardNavigationInstalled = true;
  const links = [...navigation.querySelectorAll("a[href^=\"#\"]")];
  const setCurrentLink = (sectionId) => {
    links.forEach((link) => {
      if (link.getAttribute("href") === `#${sectionId}`) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    });
  };
  links.forEach((link) => link.addEventListener("click", () => {
    const sectionId = link.getAttribute("href").slice(1);
    setCurrentLink(sectionId);
    if (sectionId === "methodology-section") document.querySelector("#methodology-section").open = true;
  }));

  const diagnosticsLink = document.querySelector("#rail-diagnostics-link");
  diagnosticsLink?.addEventListener("click", () => {
    document.querySelector("#diagnostics-section").open = true;
    document.querySelector(".rail-health-details").open = false;
  });

  dom.railDataNotice?.addEventListener("click", () => {
    if (!dom.railHealthDetails) return;
    dom.railHealthDetails.open = true;
    dom.railDataNotice.setAttribute("aria-expanded", "true");
    dom.railHealthDetails.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  dom.railHealthDetails?.addEventListener("toggle", () => {
    dom.railDataNotice?.setAttribute("aria-expanded", String(dom.railHealthDetails.open));
  });
  const healthSummary = dom.railHealthDetails?.querySelector("summary");
  healthSummary?.addEventListener("click", (event) => {
    event.preventDefault();
    dom.railHealthDetails.open = !dom.railHealthDetails.open;
  });
  dom.railHealthDetails?.querySelector(".rail-health-close")?.addEventListener("click", () => {
    dom.railHealthDetails.open = false;
  });

  const sectionByElement = new Map(links.map((link) => {
    const id = link.getAttribute("href").slice(1);
    return [document.querySelector(`#${id}`), id];
  }).filter(([element]) => element));
  const dock = document.querySelector(".control-dock");
  const getDockOffset = () => {
    const measured = dock?.getBoundingClientRect().height || 96;
    const offset = Math.ceil(measured + (window.innerWidth <= 760 ? 6 : 12));
    document.documentElement.style.setProperty("--control-dock-offset", `${offset}px`);
    return offset;
  };
  let observer = null;
  const observeSections = () => {
    if (typeof window.IntersectionObserver !== "function") return;
    observer?.disconnect();
    observer = new window.IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((left, right) => right.intersectionRatio - left.intersectionRatio);
      if (visible.length) setCurrentLink(sectionByElement.get(visible[0].target));
    }, { rootMargin: `-${getDockOffset()}px 0px -62% 0px`, threshold: [0, 0.1, 0.4] });
    sectionByElement.forEach((_, section) => observer.observe(section));
    navigation.__sectionObserver = observer;
  };
  observeSections();
  if (dock && typeof window.ResizeObserver === "function") {
    const resizeObserver = new window.ResizeObserver(() => observeSections());
    resizeObserver.observe(dock);
    navigation.__dockResizeObserver = resizeObserver;
  }
}

let mobileDockFrame = null;

function updateMobileDockState() {
  mobileDockFrame = null;
  const mobile = window.innerWidth <= 760;
  const dashboardReady = document.body.classList.contains("dashboard-ready");
  const loading = dom.button.classList.contains("loading");
  const settingsOpen = dom.workerSettings.open;
  const heroHeight = document.querySelector(".hero")?.offsetHeight || 96;
  const shouldCondense = mobile
    && dashboardReady
    && !loading
    && !settingsOpen
    && window.scrollY > Math.max(96, heroHeight);
  document.body.classList.toggle("mobile-dock-condensed", shouldCondense);
}

function scheduleMobileDockUpdate() {
  if (mobileDockFrame !== null) return;
  mobileDockFrame = requestAnimationFrame(updateMobileDockState);
}

function installMobileDockBehavior() {
  if (document.body.dataset.mobileDockInstalled === "true") return;
  document.body.dataset.mobileDockInstalled = "true";
  window.addEventListener("scroll", scheduleMobileDockUpdate, { passive: true });
  window.addEventListener("resize", scheduleMobileDockUpdate);
  dom.workerSettings.addEventListener("toggle", scheduleMobileDockUpdate);
  scheduleMobileDockUpdate();
}

function formatCacheDuration(milliseconds) {
  const seconds = rawNumber(milliseconds) / 1000;
  if (!finite(seconds) || seconds <= 0) return null;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${Math.round(seconds)}s`;
}

function workerCacheStatus(response, payload) {
  const header = response?.headers?.get("X-Worker-Cache")?.toUpperCase();
  if (header === "HIT") return "Worker cache hit";
  if (header === "MISS") return "Worker cache miss";
  if (header === "BYPASS") return "cache bypassed";
  const plan = payload?.requestPlan;
  const browserTtl = formatCacheDuration(plan?.browserCacheTtlMs);
  const workerTtl = formatCacheDuration(plan?.stockCacheTtlMs);
  return browserTtl && workerTtl
    ? `cache ${browserTtl} browser / ${workerTtl} Worker`
    : "cache status unavailable";
}

function renderDashboard(model, payload, responseStatus, elapsedMs, cacheStatus = "cache status unavailable") {
  dom.title.textContent = `${model.company} (${model.ticker})`;
  dom.marketSummary.textContent = `Market cap ${formatCompactMoney(model.marketCap, model.currency)} · ${model.prices.at(-1).date}`;
  dom.dashboard.hidden = false;
  document.body.classList.add("dashboard-ready");
  installDashboardNavigation();
  scheduleMobileDockUpdate();
  renderValuationRail(model, payload);
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
    cacheStatus,
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
      dataCoverage: dataCoverageChecks(model),
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
  if (!/^[A-Z0-9][A-Z0-9.^=-]{0,14}$/.test(ticker)) throw new Error("Invalid ticker format.");
  return ticker;
}

function setStatus(kind, message, elapsed = "") {
  dom.statusDot.className = `status-dot ${kind}`;
  dom.statusText.textContent = message;
  dom.elapsed.textContent = elapsed;
}

let loadingDetailTimer = null;
let loadingStartedAt = 0;
let loadingDetailBase = "";

function refreshLoadingDetail() {
  if (!dom.loadingDetail) return;
  const elapsed = loadingStartedAt > 0
    ? ` · ${((performance.now() - loadingStartedAt) / 1000).toFixed(1)}s`
    : "";
  dom.loadingDetail.textContent = loadingDetailBase ? `${loadingDetailBase}${elapsed}` : "";
}

function setLoadingDetail(message) {
  loadingDetailBase = message || "";
  refreshLoadingDetail();
}

function stopLoadingDetail() {
  if (loadingDetailTimer) clearInterval(loadingDetailTimer);
  loadingDetailTimer = null;
  loadingStartedAt = 0;
  refreshLoadingDetail();
}

function startLoadingDetail() {
  stopLoadingDetail();
  loadingStartedAt = performance.now();
  setLoadingDetail("Waiting on Worker · 3 Yahoo endpoints");
  loadingDetailTimer = setInterval(refreshLoadingDetail, 250);
}

function setLoading(loading) {
  dom.button.disabled = loading;
  dom.button.classList.toggle("loading", loading);
  dom.ticker.disabled = loading;
  dom.workerUrl.disabled = loading;
  updateExportButtonState();
  if (loading) startLoadingDetail();
  else stopLoadingDetail();
  scheduleMobileDockUpdate();
}

async function analyze(event) {
  event.preventDefault();
  const started = performance.now();
  try {
    const ticker = tickerValue(dom.ticker.value);
    const workerUrl = normalizeWorkerUrl(dom.workerUrl.value);
    localStorage.setItem("stockDashboardWorkerUrl", workerUrl);
    const endpoint = `${workerUrl}/api/stock?symbol=${encodeURIComponent(ticker)}`;
    setExportStatus("");
    setLoading(true);
    setLoadingDetail("Waiting on Worker · 3 Yahoo endpoints · cache eligible");
    setStatus("loading", `${ticker}: Fetching Yahoo data through the Worker…`);
    const response = await fetch(endpoint, { headers: { Accept: "application/json" } });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`Worker returned non-JSON data (HTTP ${response.status}).`);
    }
    if (!payload?.data) throw new Error(payload?.error || `Invalid Worker response (HTTP ${response.status}).`);
    const endpointCount = Object.keys(payload.data).length;
    setLoadingDetail(`Worker response received · ${endpointCount} endpoints · building model`);
    const cacheStatus = workerCacheStatus(response, payload);
    const model = buildDashboardModel(payload, ticker);
    const elapsed = performance.now() - started;
    renderDashboard(model, payload, response.status, Math.round(elapsed), cacheStatus);
    dom.workerSettings.open = false;
    const failed = Object.entries(payload.data).filter(([, item]) => !item.ok).map(([name, item]) =>
      `${name}${item.status ? ` HTTP ${item.status}` : ""}`
    );
    setLoadingDetail(`${endpointCount} endpoints received · ${cacheStatus} · model rendered`);
    const quoteAuth = payload.data.quote?.auth;
    if (failed.length) {
      setStatus("warning", `${ticker}: Dashboard ready · Some endpoints failed (${failed.join(", ")})`, `${(elapsed / 1000).toFixed(1)}s`);
    } else if (quoteAuth?.refreshedAfter401) {
      setStatus("success", `${ticker}: dashboard ready · Yahoo session refreshed after 401`, `${(elapsed / 1000).toFixed(1)}s`);
    } else {
      const sessionText = quoteAuth?.session === "reused" ? " · Yahoo session reused" : "";
      setStatus("success", `${ticker}: dashboard ready${sessionText}`, `${(elapsed / 1000).toFixed(1)}s`);
    }
    history.replaceState(null, "", `${location.pathname}?ticker=${encodeURIComponent(ticker)}&worker=${encodeURIComponent(workerUrl)}`);
  } catch (error) {
    const elapsed = performance.now() - started;
    setLoadingDetail("Worker request failed · no model update");
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
  if (!dom.workerUrl.value) dom.workerSettings.open = true;
}

let resizeFrame = null;
window.addEventListener("resize", () => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => chartInstances.forEach((chart) => chart.resize()));
});
dom.form.addEventListener("submit", analyze);
dom.ticker.addEventListener("input", () => { dom.ticker.value = dom.ticker.value.toUpperCase(); });
dom.savePngButton?.addEventListener("click", saveDashboardPng);
dom.saveHtmlButton?.addEventListener("click", saveDashboardHtml);
installMobileDockBehavior();
initializeInputs();
