import { findCommonBaselineDate } from "./charts.js";
import { ENDPOINT_IMPACTS, MODEL, RETURN_RAIL } from "./config.js";
import { dom } from "./dom.js";
import { formatMoney, formatMultiple, formatNumber, formatPercent, forwardChange } from "./format.js";
import { clamp, escapeHtml, finite, safeDivide } from "./utils.js";

export function markerPosition(value, low, high) {
  if (!finite(value) || !finite(low) || !finite(high) || high <= low) return NaN;
  return clamp((value - low) / (high - low) * 100, 6, 94);
}

export function formatRailReturn(value) {
  return finite(value) ? formatPercent(value, 1, true) : "N/A";
}

export function setValuationVerdict(model) {
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

export function adaptiveReturnRail(values) {
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

export function currencyDetail(conversion) {
  const { financialCurrency, quoteCurrency, fxSymbol, statementRate, fxDate } = conversion;
  const ratio = conversion.adrRatio;
  const parts = [financialCurrency === quoteCurrency
    ? `${quoteCurrency} statements · no conversion`
    : `${financialCurrency} → ${quoteCurrency} @ ${formatNumber(statementRate, 4)}${fxSymbol && fxDate ? ` (${fxSymbol}, ${fxDate})` : ""}`];
  if (ratio !== 1) parts.push(`${formatNumber(ratio, ratio >= 1 ? 0 : 2)} ordinary shares per quoted share`);
  return parts.join(" · ");
}

export function dataCoverageChecks(model) {
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
      name: "Currency",
      detail: currencyDetail(model.currencyConversion),
      impact: "All per-share fundamentals, multiples and bands",
      ok: true,
    },
    {
      name: "SBC treatment",
      detail: model.sbcSource || "Unavailable",
      impact: "FCF-SBC yield, scenarios and implied IRR",
      ok: model.sbcSource === "latest four quarters",
    },
  ];
}

export function renderValuationRail(model, payload) {
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

export function cashRunwayEntry(months) {
  if (months === Infinity) return ["FCF+ (Safe)", "green"];
  if (!finite(months)) return ["N/A", "muted"];
  const text = `${formatNumber(months, 1)} mo`;
  if (months >= 24) return [text, "green"];
  return months >= 12 ? [text, ""] : [text, "red"];
}

export function renderMetrics(model) {
  const { metrics } = model;
  const baseMinusImplied = model.baseTenYearCagr - model.reverseImpliedGrowth;
  const analystTarget = finite(model.analystPriceTarget)
    ? `${formatMoney(model.analystPriceTarget, model.currency)} (${forwardChange(model.currentPrice, model.analystPriceTarget)})`
    : "N/A";
  setMetrics("snapshot-metrics", [
    ["FCF-SBC yield", formatPercent(metrics.adjustedFcfYield), metrics.adjustedFcfYield > 0.05 ? "green" : ""],
    ["Dividend yield", formatPercent(metrics.dividendYield)],
    ["PER (GAAP)", formatMultiple(metrics.per)],
    ["PER (non-GAAP)", formatMultiple(metrics.nonGaapPer)],
    ["Forward PER (+1Y EPS)", formatMultiple(metrics.forwardPer)],
    ["PSR", formatMultiple(metrics.psr)],
    ["PBR", formatMultiple(metrics.pbr)],
  ]);
  setMetrics("forward-metrics", [
    ["Analyst 1Y target", analystTarget],
    ["Implied 10Y growth", formatPercent(model.reverseImpliedGrowth)],
    ["Base implied IRR", formatPercent(model.baseImpliedIrr)],
    ["Base minus implied", finite(baseMinusImplied) ? `${formatPercent(baseMinusImplied, 1, true)}p` : "N/A", baseMinusImplied > 0 ? "green" : ""],
    ["Year-10 P/(FCF-SBC)", formatMultiple(model.exitMultiples.Base)],
  ]);
  setMetrics("profitability-metrics", [
    ["ROE", formatPercent(metrics.roe)],
    ["ROA", formatPercent(metrics.roa)],
    ["ROIC", formatPercent(metrics.roic), "roic"],
    ["FCF-SBC margin", formatPercent(metrics.adjustedFcfMargin)],
    ["Net margin", formatPercent(metrics.netMargin)],
    ["SBC margin", formatPercent(metrics.sbcMargin), metrics.sbcMargin > 0.10 ? "red" : ""],
    ["Share-count CAGR", formatPercent(metrics.shareCountCagr, 1, true)],
  ]);
  setMetrics("balance-metrics", [
    ["Debt / Share", formatMoney(metrics.debtPerShare, model.currency)],
    ["Cash / Share", formatMoney(metrics.cashPerShare, model.currency)],
    ["Net debt / EBITDA", formatMultiple(metrics.netDebtToEbitda, 2)],
    ["Interest coverage", formatMultiple(metrics.interestCoverage)],
    ["Current ratio", formatMultiple(metrics.currentRatio, 2)],
    ["Quick ratio", formatMultiple(metrics.quickRatio, 2)],
    ["Cash runway", ...cashRunwayEntry(metrics.cashRunway)],
  ]);
}

export function setMetrics(id, entries) {
  document.querySelector(`#${id}`).innerHTML = entries.map(([label, value, color = ""]) =>
    `<dt title="${escapeHtml(label)}">${escapeHtml(label)}</dt><dd class="${color}">${escapeHtml(value)}</dd>`
  ).join("");
}
