import { actualPriceSeries, commonChartOption, endLabelAtLineRight, formatCompactAxisPrice, setCaption, setInsight, tooltipDateLabel, tooltipNumericValue, valuationAreaSeries } from "./chart-common.js";
import { setChart } from "./chart-interaction.js";
import { BAND_COLORS, BAND_LINE_TYPES, BAND_SMOOTH, CHART_GRID, COLORS, MODEL, NUMERIC_FONT } from "./config.js";
import { formatMoney, formatMultiple, formatNumber, formatPercent, forwardChange } from "./format.js";
import { createPchipInterpolator, utcDay } from "./model.js";
import { addDays, addYears, clamp, escapeHtml, finite, quantile, yearStart } from "./utils.js";

const BAND_PERCENTILES = [10, 25, 50, 75, 90];

function chartLayout(option, model, rightPadding) {
  const compact = window.innerWidth <= 760;
  const veryCompact = window.innerWidth <= 470;
  option.grid.left = veryCompact ? 50 : compact ? 62 : CHART_GRID.left;
  option.grid.right = veryCompact ? rightPadding[0] : compact ? rightPadding[1] : rightPadding[2];
  option.legend.show = false;
  if (veryCompact) {
    option.yAxis.name = "";
    if (model) option.yAxis.axisLabel.formatter = (value) => formatCompactAxisPrice(value, model);
    option.xAxis.splitNumber = 4;
    option.xAxis.axisLabel.formatter = (value) => String(new Date(value).getUTCFullYear());
  }
  return { compact, veryCompact, labelSize: veryCompact ? 8 : compact ? 9 : 11, labelOffset: veryCompact ? 4 : compact ? 6 : 8 };
}

// Today as a dotted line, the forward year as a light shade, and the current price as a dot.
function todaySeries(model, forwardEnd = null) {
  const currentDate = model.chartPrices.at(-1).date;
  return [
    {
      name: "Today",
      type: "line",
      data: [],
      markLine: { silent: true, symbol: "none", lineStyle: { color: "#aeb8bb", type: "dotted", opacity: 0.65 }, label: { show: false }, data: [{ xAxis: currentDate }] },
      ...(forwardEnd ? { markArea: { silent: true, itemStyle: { color: "rgba(208,208,208,0.035)" }, data: [[{ xAxis: currentDate }, { xAxis: forwardEnd }]] } } : {}),
    },
    {
      name: "Current price",
      type: "scatter",
      data: [[currentDate, model.chartPrices.at(-1).value]],
      symbolSize: 6,
      itemStyle: { color: COLORS.price },
      silent: true,
      z: 11,
    },
  ];
}

// Drop trailing gaps so a line's end label sits on its last drawn point.
function trimTrailingGaps(path) {
  let end = path.length;
  while (end > 0 && !finite(path[end - 1][1])) end -= 1;
  return path.slice(0, end);
}

function weeklyDates(startDate, endDate) {
  const dates = [];
  for (let cursor = addDays(startDate, 7); cursor < endDate; cursor = addDays(cursor, 7)) dates.push(cursor);
  dates.push(endDate);
  return dates;
}

function naGraphic(text) {
  return [{ type: "text", left: "center", top: "middle", style: { text, fill: "#aab4b7", font: "12px sans-serif", textAlign: "center", lineHeight: 20 } }];
}

function daysBetween(fromDate, toDate) {
  return utcDay(toDate) - utcDay(fromDate);
}

// Revenue growth, FCF and SBC margins, Rule of Forty, ROIC, share count and net debt per period (trading2.py).
export function growthEfficiencyRows(model) {
  const rows = model.fundamentals;
  const chartStart = yearStart(model.chartPrices[0].date);
  const result = rows.map((row, index) => {
    let growth = NaN;
    const previous = rows[index - 1];
    if (previous) {
      const days = daysBetween(previous.date, row.date);
      if (days < 300) {
        // Latest TTM point: same-period YoY growth, never annualized.
        growth = model.latestRevenueGrowth;
      } else if (days <= 430) {
        // Growth in the reporting currency so FX moves between fiscal years do not show up as growth.
        const ratio = (row.revenue / row.fxRate) / (previous.revenue / previous.fxRate);
        if (previous.revenue > 0 && finite(ratio) && ratio > 0) growth = ratio - 1;
      }
    }
    const revenuePerShare = row.revenuePerShare > 0 ? row.revenuePerShare : NaN;
    const fcfMargin = row.fcfPerShare / revenuePerShare;
    const sbcMargin = row.sbcPerShare / revenuePerShare;
    return {
      date: row.date,
      revenueGrowth: growth * 100,
      fcfMargin: fcfMargin * 100,
      sbcMargin: sbcMargin * 100,
      ruleOfForty: (growth + fcfMargin - sbcMargin) * 100,
      roic: row.roic * 100,
      revenuePerShare,
    };
  });

  // Share count as cumulative % change from the first point visible on the chart.
  const shareRows = rows.filter((row) => row.shares > 0);
  const shareBaseline = shareRows.find((row) => row.date >= chartStart) || shareRows[0];
  result.forEach((item, index) => {
    const shares = rows[index].shares;
    item.sharesChange = shareBaseline && shares > 0 && item.date >= shareBaseline.date
      ? (shares / shareBaseline.shares - 1) * 100
      : NaN;
  });

  // Net debt as % of revenue using the latest balance sheet within 120 days, as a %p change from the first visible point.
  const netDebt = model.netDebtPerShareHistory;
  result.forEach((item) => {
    const earlier = netDebt.filter((row) => row.date <= item.date).at(-1);
    item.netDebtRatio = earlier && daysBetween(earlier.date, item.date) <= 120
      ? earlier.value / item.revenuePerShare * 100
      : NaN;
  });
  const ratioBaseline = result.find((item) => item.date >= chartStart && finite(item.netDebtRatio));
  result.forEach((item) => {
    item.netDebtToRevenue = ratioBaseline && item.date >= ratioBaseline.date
      ? item.netDebtRatio - ratioBaseline.netDebtRatio
      : NaN;
  });
  return result;
}

export function renderGrowthChart(model) {
  const option = commonChartOption(model, "Percent (%)", "growth-chart");
  const { veryCompact, labelSize, labelOffset } = chartLayout(option, null, [96, 120, 168]);
  option.yAxis.axisLabel.formatter = (value) => `${Math.round(value)}%`;
  option.yAxis.splitNumber = 5;
  // Keep the 0% and 40% reference lines in view, with headroom for the end labels.
  const span = (extent) => Math.max(extent.max, 40) - Math.min(extent.min, 0);
  option.yAxis.min = (extent) => Math.floor((Math.min(extent.min, 0) - span(extent) * 0.05) / 10) * 10;
  option.yAxis.max = (extent) => Math.ceil((Math.max(extent.max, 40) + span(extent) * 0.14) / 10) * 10;
  option.tooltip.formatter = (params) => {
    const entries = (Array.isArray(params) ? params : [params]).filter((item) => finite(tooltipNumericValue(item)));
    if (!entries.length) return "";
    return [escapeHtml(tooltipDateLabel(entries[0])), ...entries.map((item) =>
      `${item.marker}${escapeHtml(item.seriesName)}: ${formatNumber(tooltipNumericValue(item), 1)}${item.seriesName === "Net debt/Rev chg" ? "%p" : "%"}`)].join("<br/>");
  };
  const rows = growthEfficiencyRows(model);
  const definitions = [
    ["Revenue growth", "revenueGrowth", COLORS.revenue, 1.15],
    ["FCF margin", "fcfMargin", COLORS.fcf, 1.15],
    ["SBC Margin", "sbcMargin", COLORS.eps, 1.15],
    ["Rule of Forty", "ruleOfForty", COLORS.warning, 1.9],
    ["ROIC", "roic", COLORS.roic, 1.15],
    ["Shares", "sharesChange", COLORS.shares, 1.15],
    ["Net debt/Rev chg", "netDebtToRevenue", COLORS.netDebt, 1.15],
  ];
  for (const [name, field, color, width] of definitions) {
    const data = rows.filter((row) => finite(row[field])).map((row) => [row.date, row[field]]);
    if (!data.length) continue;
    const latest = data.at(-1)[1];
    const netDebtLine = field === "netDebtToRevenue";
    const valueText = netDebtLine ? `${latest >= 0 ? "+" : ""}${formatNumber(latest, 1)}%p` : `${formatNumber(latest, 1)}%`;
    option.series.push({
      name,
      type: "line",
      data,
      showSymbol: true,
      symbolSize: 4,
      lineStyle: { color, width, type: netDebtLine ? "dashed" : "solid" },
      itemStyle: { color },
      endLabel: {
        show: true,
        formatter: veryCompact ? valueText : `${name} ${valueText}`,
        color,
        fontSize: labelSize,
        fontWeight: 600,
      },
      labelLayout: endLabelAtLineRight(labelOffset),
      z: field === "ruleOfForty" ? 4 : 3,
    });
  }
  option.series.push({
    name: "Reference",
    type: "line",
    data: [],
    markLine: {
      silent: true,
      symbol: "none",
      label: { show: false },
      data: [
        { yAxis: 40, lineStyle: { color: COLORS.warning, type: "dotted", opacity: 0.7 } },
        { yAxis: 0, lineStyle: { color: "#687277", type: "dotted", opacity: 1 } },
      ],
    },
  });
  if (option.series.length === 1) option.graphic = naGraphic("Growth / margin data: N/A");
  setChart("growth-chart", option, { model, priceChart: false, coordinateTooltip: false });
  const latest = rows.at(-1) || {};
  setInsight("growth-insight", [
    ["Rule of Forty", finite(latest.ruleOfForty) ? `${formatNumber(latest.ruleOfForty, 1)}%` : "N/A"],
    ["Latest revenue growth", finite(latest.revenueGrowth) ? `${formatNumber(latest.revenueGrowth, 1)}%` : "N/A"],
  ]);
}

export function renderFcfChart(model) {
  const option = commonChartOption(model, `Price (${model.currency})`, "fcf-chart", true);
  const { labelSize, labelOffset } = chartLayout(option, model, [28, 32, 40]);
  const currentDate = model.chartPrices.at(-1).date;
  const futureDate = addYears(currentDate, MODEL.horizonYears);
  // Reported FCF-SBC/share plus the one-year Base path; no carry before the first report.
  const anchors = model.fundamentals.filter((row) => finite(row.adjustedFcfPerShare));
  if (finite(model.currentAdjustedFcfPerShare) && finite(model.baseGrowth)) {
    anchors.push({ date: futureDate, adjustedFcfPerShare: model.currentAdjustedFcfPerShare * (1 + model.baseGrowth) });
  }
  const fcfSpline = createPchipInterpolator(anchors, "adjustedFcfPerShare", false);
  const dates = [...model.chartPrices.map((row) => row.date), ...weeklyDates(currentDate, futureDate)];
  const paths = MODEL.yields.map((yieldValue) => trimTrailingGaps(dates.map((date) => {
    const driver = fcfSpline(date);
    return [date, driver > 0 ? driver / yieldValue : NaN];
  })));
  // Higher FCF yields produce lower implied prices, so reverse the shared
  // palette to keep the vertical color order consistent with PSR and EV/EBITDA.
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
      lineStyle: { color: fcfBandColors[index], width: 1.15, type: "solid", opacity: 0.88 },
      itemStyle: { color: fcfBandColors[index] },
      endLabel: {
        show: path.length > 0,
        formatter: `${Math.round(MODEL.yields[index] * 100)}%`,
        color: fcfBandColors[index],
        fontSize: labelSize,
        fontWeight: 600,
      },
      labelLayout: endLabelAtLineRight(labelOffset),
      z: 4,
    });
  });
  option.series.push(...todaySeries(model));
  if (!paths.some((path) => path.length)) option.graphic = naGraphic("FCF-SBC yield bands: N/A\nFCF-SBC/share is non-positive");
  setChart("fcf-chart", option, { model, priceChart: true, coordinateTooltip: true });
  const positiveFcf = model.currentAdjustedFcfPerShare > 0;
  setInsight("fcf-insight", [
    ["Current FCF-SBC yield", positiveFcf
      ? `${formatPercent(model.metrics.adjustedFcfYield)} (${formatMoney(model.currentPrice, model.currency)})`
      : "N/A (non-positive FCF-SBC/share)"],
  ]);
  setCaption("fcf-caption", [
    ["Current FCF-SBC/share", formatMoney(model.currentAdjustedFcfPerShare, model.currency)],
    ["Analyst 1Y Price Target/share", finite(model.analystPriceTarget)
      ? `${formatMoney(model.analystPriceTarget, model.currency)} (${forwardChange(model.currentPrice, model.analystPriceTarget)})`
      : "N/A"],
  ]);
}

// Historical multiple bands over the chart window plus a one-year forward region driven by the
// analyst estimate. EV bands add net debt/share to the price and subtract it from each band edge.
export function calculateValuationBand(model, field, analystDriver, enterpriseValue = false) {
  const currentDate = model.chartPrices.at(-1).date;
  const futureDate = addYears(currentDate, MODEL.horizonYears);
  const reported = model.fundamentals.filter((row) => finite(row[field]));
  const anchors = [...reported];
  // Hold the latest reported driver flat until today.
  if (anchors.length && anchors.at(-1).date < currentDate) anchors.push({ date: currentDate, [field]: anchors.at(-1)[field] });
  const driverSpline = createPchipInterpolator(anchors, field, false);
  const netDebtSpline = enterpriseValue && model.netDebtPerShareHistory.length
    ? createPchipInterpolator(model.netDebtPerShareHistory, "value", true)
    : () => 0;
  const historical = model.chartPrices.map((row) => {
    const driver = driverSpline(row.date);
    const netDebt = netDebtSpline(row.date);
    return { date: row.date, driver, netDebt, multiple: driver > 0 ? (row.value + netDebt) / driver : NaN };
  });
  const currentDriver = driverSpline(currentDate);
  const currentNetDebt = enterpriseValue ? netDebtSpline(currentDate) : 0;
  const multiples = historical.map((row) => row.multiple).filter((value) => finite(value) && value > 0);
  const base = { historical, levels: [], paths: [], endpoints: [], currentDriver, currentNetDebt, futureDate, projection: "none" };
  if (multiples.length < 30) return base;

  const low = quantile(multiples, 0.05);
  const high = quantile(multiples, 0.95);
  const clipped = multiples.map((value) => clamp(value, low, high));
  const levels = BAND_PERCENTILES.map((percentile) => quantile(clipped, percentile / 100));

  let projection = "none";
  if (field === "ebitdaPerShare" && currentDriver > 0 && analystDriver > currentDriver * MODEL.forwardMaxDriverRatio) {
    projection = "skipped";
  } else if (analystDriver > 0 && finite(currentDriver)) {
    // A positive estimate does not say when a negative driver breaks even, so show only the endpoint.
    projection = currentDriver > 0 ? "path" : "endpoint";
  }
  let projectionDrivers = [];
  if (projection === "path") {
    const projectionSpline = createPchipInterpolator([
      ...reported.filter((row) => row.date < currentDate),
      { date: currentDate, [field]: currentDriver },
      { date: futureDate, [field]: analystDriver },
    ], field, false);
    projectionDrivers = weeklyDates(currentDate, futureDate).map((date) => [date, projectionSpline(date)]);
  }
  const paths = levels.map((level) => {
    const path = historical.map((row) => [row.date, row.driver > 0 ? row.driver * level - row.netDebt : NaN]);
    // The projection holds the latest balance sheet constant.
    path.push(...projectionDrivers.map(([date, driver]) => [date, driver > 0 ? driver * level - currentNetDebt : NaN]));
    return trimTrailingGaps(path);
  });
  const endpoints = projection === "path" || projection === "endpoint"
    ? levels.map((level) => [futureDate, analystDriver * level - currentNetDebt])
    : [];
  return { ...base, levels, paths, endpoints, projection };
}

export function renderValuationBandChart(model, { id, field, name, analystDriver, analystLabel, analystCaveat = "", enterpriseValue = false }) {
  const calculation = calculateValuationBand(model, field, analystDriver, enterpriseValue);
  const hasForward = calculation.endpoints.length > 0;
  const option = commonChartOption(model, `Price (${model.currency})`, `${id}-chart`, true);
  const { labelSize, labelOffset } = chartLayout(option, model, [56, 62, 78]);
  if (calculation.levels.length === 5) {
    for (let index = 0; index < 4; index += 1) {
      option.series.push(valuationAreaSeries(`${name} area`, calculation.paths[index], calculation.paths[index + 1], BAND_COLORS[index + 1], BAND_COLORS[index]));
    }
    calculation.paths.forEach((path, index) => {
      const isMedian = index === 2;
      const label = `P${BAND_PERCENTILES[index]} ${calculation.levels[index].toFixed(1)}x`;
      const endpoint = calculation.endpoints[index];
      option.series.push({
        name: `${name} ${label}`,
        type: "line",
        // An endpoint-only projection is a separate dot; a path projection is already in the line.
        data: calculation.projection === "endpoint" ? [...path, [model.chartPrices.at(-1).date, NaN], endpoint] : path,
        showSymbol: false,
        smooth: BAND_SMOOTH,
        smoothMonotone: "x",
        connectNulls: false,
        lineStyle: { color: BAND_COLORS[index], width: isMedian ? 1.15 : 1, type: BAND_LINE_TYPES[index], opacity: isMedian ? 1 : 0.78 },
        itemStyle: { color: BAND_COLORS[index] },
        endLabel: { show: true, formatter: label, color: BAND_COLORS[index], fontSize: labelSize, fontWeight: 500 },
        labelLayout: endLabelAtLineRight(labelOffset),
        z: isMedian ? 4 : 3,
      });
    });
    if (hasForward) {
      option.series.push({
        name: `${name} +1Y`,
        type: "scatter",
        data: calculation.endpoints.map((point, index) => ({ value: point, itemStyle: { color: BAND_COLORS[index], opacity: 0.85 } })),
        symbolSize: 5,
        silent: true,
        z: 5,
      });
    }
  } else {
    option.graphic = naGraphic(`${name} bands: N/A\nFewer than 30 positive observations`);
  }
  option.series.push(actualPriceSeries(model));
  option.series.push(...todaySeries(model, hasForward ? calculation.futureDate : null));
  setChart(`${id}-chart`, option, { model, priceChart: true, coordinateTooltip: true });

  const { currentDriver, currentNetDebt } = calculation;
  const currentMultiple = currentDriver > 0 ? (model.currentPrice + currentNetDebt) / currentDriver : NaN;
  setInsight(`${id}-insight`, calculation.levels.length === 5
    ? [[`Current ${name}`, formatMultiple(currentMultiple)], ["Historical median", formatMultiple(calculation.levels[2])]]
    : [[`Historical ${name}`, "Unavailable"], ["Band rule", "<30 positive observations"]]);

  const change = forwardChange(currentDriver, analystDriver);
  let analystText = "N/A";
  if (calculation.projection === "skipped") {
    analystText = `${formatMoney(analystDriver, model.currency)} (${change}; forward skipped: >${MODEL.forwardMaxDriverRatio}x current)`;
  } else if (hasForward) {
    const notes = [change, analystCaveat, calculation.projection === "endpoint" ? "endpoint only" : ""].filter(Boolean);
    analystText = `${formatMoney(analystDriver, model.currency)} (${notes.join("; ")})`;
  } else if (finite(analystDriver) && analystDriver <= 0) {
    analystText = `${formatMoney(analystDriver, model.currency)} (non-positive; forward skipped)`;
  }
  const captions = [[analystLabel, analystText]];
  if (enterpriseValue) {
    captions.push(["Net debt/share", `${currentNetDebt < 0 ? "-" : ""}${formatMoney(Math.abs(currentNetDebt), model.currency)}`]);
  }
  setCaption(`${id}-caption`, captions);
}

export function findCommonBaselineDate(rows, fields) {
  return rows.find((row) => row.date && fields.every((field) => finite(row[field]) && Math.abs(row[field]) > 1e-9))?.date || null;
}
