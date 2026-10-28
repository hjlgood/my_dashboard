import { MODEL } from "./config.js";
import { adrRatio, convertSeriesMap, currencyPair, estimateRate, revenueEstimateRate, spotRate } from "./currency.js";
import { addYears, clamp, dateKey, finite, median, quantile, rawNumber, safeDivide, seriesCagr } from "./utils.js";
import { collectTimeseries, firstSeries, latestValue, meanRecent, nearestAnnualValue, parseChart, parseQuote, quoteTrendRow, sumRecent, unwrapEndpoint } from "./yahoo.js";

export function buildAnnualFundamentals(seriesMap, sharesPerQuotedShare = 1) {
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
    // Statement share counts are ordinary shares; Yahoo's EPS is already per quoted share (ADS).
    const shares = nearestAnnualValue(sharesRows, date) / sharesPerQuotedShare;
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

export function trailingDividendYield(payload, quote, prices, currentPrice) {
  const events = unwrapEndpoint(payload, "chart")?.chart?.result?.[0]?.events;
  if (events) {
    const start = addYears(prices.at(-1).date, -1);
    const total = Object.values(events.dividends || {})
      .filter((row) => finite(row?.date) && dateKey(row.date * 1000) > start)
      .reduce((sum, row) => sum + (finite(rawNumber(row.amount)) ? rawNumber(row.amount) : 0), 0);
    return safeDivide(total, currentPrice);
  }
  const detail = quote?.summaryDetail;
  const fallback = rawNumber(detail?.trailingAnnualDividendYield);
  return finite(fallback) ? fallback : rawNumber(detail?.dividendYield);
}

export function nonGaapTtmEps(quote) {
  const history = quote?.earningsHistory?.history;
  if (!Array.isArray(history)) return NaN;
  const actuals = history
    .map((row) => ({ quarter: rawNumber(row?.quarter), eps: rawNumber(row?.epsActual) }))
    .filter((row) => finite(row.eps))
    .sort((a, b) => (finite(a.quarter) ? a.quarter : 0) - (finite(b.quarter) ? b.quarter : 0))
    .slice(-4);
  return actuals.length === 4 ? actuals.reduce((sum, row) => sum + row.eps, 0) : NaN;
}

export function buildDashboardModel(payload, ticker, fx = { ...currencyPair(payload), rates: [] }) {
  if (fx.fxSymbol && !fx.rates.length) throw new Error(`${fx.fxSymbol} exchange rates are required to convert ${fx.financialCurrency} statements.`);
  const { prices, meta } = parseChart(payload);
  const seriesMap = convertSeriesMap(collectTimeseries(payload), fx);
  const statementRate = fx.scale * spotRate(fx.rates);
  const quote = parseQuote(payload);
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
  const quotedShares = safeDivide(rawNumber(quote?.price?.marketCap), currentPrice);
  const adr = adrRatio(
    latestValue(quarterly(["OrdinarySharesNumber", "ShareIssued"])),
    quotedShares > 0 ? quotedShares : currentShares,
  );
  const annualRows = buildAnnualFundamentals(seriesMap, adr);

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
  const analystRevenue = rawNumber(trend?.revenueEstimate?.avg)
    * revenueEstimateRate(quote, latestValue(firstSeries(seriesMap, "annual", ["TotalRevenue"])), statementRate, revenue);
  const analystRevenuePerShare = analystRevenue > 0 ? analystRevenue / currentShares : NaN;
  let forwardRevenueGrowth = rawNumber(trend?.revenueEstimate?.growth);
  const yearAgoRevenue = rawNumber(trend?.revenueEstimate?.yearAgoRevenue);
  if (!finite(forwardRevenueGrowth) && analystRevenue > 0 && yearAgoRevenue > 0) {
    forwardRevenueGrowth = analystRevenue / yearAgoRevenue - 1;
  }
  // Yahoo's earnings history and EPS estimates share one currency, detected against GAAP TTM EPS.
  const rawNonGaapEps = nonGaapTtmEps(quote);
  const epsReference = eps > 0 ? eps : rawNumber(quote?.defaultKeyStatistics?.trailingEps);
  const epsEstimateRate = estimateRate(rawNonGaapEps, epsReference, statementRate);
  const analystEps = rawNumber(trend?.earningsEstimate?.avg) * epsEstimateRate;
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
  const debtForShare = finite(totalDebt) ? totalDebt : netDebt + cash;
  const cashRunway = finite(fcf) && fcf >= 0
    ? Infinity
    : (finite(cash) && finite(fcf) ? safeDivide(cash, -fcf / 12) : NaN);

  return {
    ticker, company, currency, prices, meta, seriesMap, quote, fundamentals,
    currencyConversion: {
      financialCurrency: fx.financialCurrency,
      quoteCurrency: fx.quoteCurrency,
      fxSymbol: fx.fxSymbol,
      statementRate,
      fxDate: fx.rates.at(-1)?.date || null,
      adrRatio: adr,
    },
    currentPrice, currentShares, marketCap, revenue, fcf, sbc, sbcSource, adjustedFcf,
    currentAdjustedFcfPerShare, currentMultiple, historicalCagrs, historicalBaseGrowth,
    analystRevenuePerShare,
    analystEps: analystEps > 0 ? analystEps : NaN,
    analystPriceTarget: analystPriceTarget > 0 ? analystPriceTarget : NaN,
    forwardRevenueGrowth, baseGrowth, growthScenarios, exitMultiples, scenarios,
    secondStageGrowth, baseTenYearCagr, reverseImpliedGrowth, baseImpliedIrr,
    metrics: {
      adjustedFcfYield: safeDivide(adjustedFcf, marketCap),
      dividendYield: trailingDividendYield(payload, quote, prices, currentPrice),
      per: eps > 0 ? currentPrice / eps : NaN,
      nonGaapPer: safeDivide(currentPrice, rawNonGaapEps * epsEstimateRate),
      forwardPer: analystEps > 0 ? currentPrice / analystEps : NaN,
      psr: safeDivide(currentPrice, safeDivide(revenue, currentShares)),
      pbr: safeDivide(marketCap, equity),
      roe: safeDivide(netIncome, averageEquity),
      roa: safeDivide(netIncome, averageAssets),
      roic,
      adjustedFcfMargin: safeDivide(adjustedFcf, revenue),
      netMargin: safeDivide(netIncome, revenue),
      sbcMargin: safeDivide(sbc, revenue),
      shareCountCagr: seriesCagr(fundamentals, "shares"),
      netDebt,
      debtPerShare: safeDivide(debtForShare, currentShares),
      cashPerShare: safeDivide(cash, currentShares),
      cashRunway,
      netDebtToEbitda: safeDivide(netDebt, ebitda),
      interestCoverage: safeDivide(operatingIncome, interestExpense),
      currentRatio: safeDivide(currentAssets, currentLiabilities),
      quickRatio: safeDivide(cash + receivables, currentLiabilities),
    },
  };
}

export function utcDay(dateString) {
  return Date.parse(`${dateString}T00:00:00Z`) / 86400000;
}

export function pchipEndpointSlope(h0, h1, slope0, slope1) {
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

export function createPchipInterpolator(rows, field, carryBeforeFirst = false) {
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

export function solveGrowth(currentPrice, fcfPerShare, requiredReturn, terminalMultiple, years) {
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

export function twoStageValue(fcfPerShare, firstGrowth, secondGrowth, returnRate, terminalMultiple, years) {
  if (!(fcfPerShare > 0) || returnRate <= -1 || years < 2) return NaN;
  let futureFcf = fcfPerShare;
  let presentValue = 0;
  for (let year = 1; year <= years; year += 1) {
    futureFcf *= 1 + (year <= Math.floor(years / 2) ? firstGrowth : secondGrowth);
    presentValue += futureFcf / (1 + returnRate) ** year;
  }
  return presentValue + futureFcf * terminalMultiple / (1 + returnRate) ** years;
}

export function solveIrr(currentPrice, fcfPerShare, firstGrowth, secondGrowth, terminalMultiple, years) {
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
