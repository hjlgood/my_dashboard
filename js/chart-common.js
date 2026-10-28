import { CHART_GRID, COLORS, NUMERIC_FONT } from "./config.js";
import { currencySymbol, formatMoney, formatNumber } from "./format.js";
import { addDays, addYears, escapeHtml, finite, rawNumber, yearStart } from "./utils.js";

export const chartInstances = new Map();
export const chartPointerStates = new Map();

export function tooltipNumericValue(item) {
  const value = item?.value;
  return rawNumber(Array.isArray(value) ? value.at(-1) : value);
}

export function tooltipDateLabel(item) {
  const rawValue = item?.axisValue ?? (Array.isArray(item?.value) ? item.value[0] : null);
  if (rawValue == null || rawValue === "") return "N/A";
  const date = new Date(rawValue);
  return Number.isNaN(date.getTime()) ? String(rawValue ?? "N/A") : date.toISOString().slice(0, 10);
}

export function formatAxisDate(value) {
  const numeric = rawNumber(value);
  const date = finite(numeric) ? new Date(numeric) : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value ?? "N/A") : date.toISOString().slice(0, 10);
}

export function formatAxisPrice(value, model) {
  return formatMoney(rawNumber(value), model.currency, 2);
}

export function formatCompactAxisPrice(value, model) {
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

export function formatHoverTooltip(params, model, priceChart, chartId, coordinateTooltip) {
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

export function endLabelAtLineInside(offsetX = 8) {
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

export function endLabelAtLineRight(offsetX = 8) {
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

export function commonChartOption(model, yName, chartId = null, coordinateTooltip = false) {
  const lastDate = model.chartPrices.at(-1).date;
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
      min: new Date(yearStart(model.chartPrices[0].date)).getTime(),
      // Leaves room inside the axes for endpoint labels such as "P90 47.3x".
      max: new Date(addDays(addYears(lastDate, 1), 240)).getTime(),
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

export function actualPriceSeries(model) {
  return {
    name: "Actual price",
    type: "line",
    data: model.chartPrices.map((row) => [row.date, row.value]),
    showSymbol: false,
    lineStyle: { color: COLORS.price, width: 1.9 },
    itemStyle: { color: COLORS.price },
    z: 10,
  };
}

export function rgba(hex, alpha) {
  const value = hex.replace("#", "");
  const number = Number.parseInt(value, 16);
  return `rgba(${(number >> 16) & 255},${(number >> 8) & 255},${number & 255},${alpha})`;
}

export function bandAreaFill(topColor, bottomColor = topColor) {
  if (window.echarts?.graphic?.LinearGradient) {
    return new window.echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: rgba(topColor, 0.09) },
      { offset: 1, color: rgba(bottomColor, 0.09) },
    ]);
  }
  return rgba(topColor, 0.09);
}

export function valuationAreaSeries(name, lower, upper, topColor, bottomColor = topColor) {
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

export function setInsight(id, entries) {
  const element = document.querySelector(`#${id}`);
  if (!element) return;
  const usable = Array.isArray(entries) ? entries.filter((entry) => Array.isArray(entry) && entry.length >= 2) : [];
  element.innerHTML = usable.map(([label, value]) =>
    `<span class="insight-token"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></span>`
  ).join("");
  element.hidden = !usable.length;
}

export function setCaption(id, entries) {
  document.querySelector(`#${id}`).innerHTML = entries.map(([label, value]) => {
    const safeLabel = escapeHtml(label);
    const safeValue = escapeHtml(value);
    return `<span class="caption-metric" title="${safeLabel}: ${safeValue}"><span class="caption-label">${safeLabel}</span><strong>${safeValue}</strong></span>`;
  }).join("");
}
