import { chartInstances, chartPointerStates, formatAxisDate, formatAxisPrice } from "./chart-common.js";
import { CHART_GRID, HORIZONTAL_CROSSHAIR_ID } from "./config.js";
import { dom } from "./dom.js";
import { formatNumber } from "./format.js";
import { clamp, escapeHtml, finite, rawNumber } from "./utils.js";

export function chartGridRect(chart) {
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

export function updateChartPointerState(chart, chartId, x, y) {
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

export function hideCoordinateTooltip() {
  if (!dom.coordinateTooltip) return;
  dom.coordinateTooltip.hidden = true;
  dom.coordinateTooltip.setAttribute("aria-hidden", "true");
  dom.coordinateTooltip.style.left = "-9999px";
  dom.coordinateTooltip.style.top = "-9999px";
}

export function showCoordinateTooltip(chart, chartId, x, y) {
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

export function installHorizontalCrosshair(chart, chartId = null) {
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

export function setChart(id, option, context = null) {
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
