import { actualPriceSeries, commonChartOption, endLabelAtLineInside, endLabelAtLineRight, formatCompactAxisPrice, setCaption, setInsight, valuationAreaSeries } from "./chart-common.js";
import { setChart } from "./chart-interaction.js";
import { BAND_COLORS, BAND_LINE_TYPES, BAND_SMOOTH, CHART_GRID, COLORS, MODEL, NUMERIC_FONT } from "./config.js";
import { formatMoney, formatMultiple, formatNumber, formatPercent, forwardChange } from "./format.js";
import { createPchipInterpolator } from "./model.js";
import { addDays, addYears, clamp, finite, quantile } from "./utils.js";
import { latestValue } from "./yahoo.js";

export function renderFcfChart(model) {
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

export function calculateValuationBand(model, field, analystDriver) {
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

export function renderMultipleChart(model, elementId, captionId, field, name, analystDriver, analystLabel) {
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

export function findCommonBaselineDate(rows, fields) {
  return rows.find((row) => row.date && fields.every((field) => finite(row[field]) && Math.abs(row[field]) > 1e-9))?.date || null;
}

export function normalizedSeries(rows, field, baselineDate = null) {
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

export function renderFundamentalsChart(model) {
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
