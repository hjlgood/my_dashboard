import { chartInstances } from "./js/chart-common.js";
import { renderFcfChart, renderFundamentalsChart, renderMultipleChart } from "./js/charts.js";
import { MODEL } from "./js/config.js";
import { currencyPair, fetchFxRates } from "./js/currency.js";
import { dom } from "./js/dom.js";
import { saveDashboardHtml, saveDashboardPng, setExportStatus, updateExportButtonState } from "./js/export.js";
import { formatCompactMoney } from "./js/format.js";
import { installDashboardInteractions, installMobileDockBehavior, scheduleMobileDockUpdate } from "./js/layout.js";
import { buildDashboardModel } from "./js/model.js";
import { dataCoverageChecks, renderMetrics, renderValuationRail } from "./js/panels.js";
import { finite, rawNumber } from "./js/utils.js";

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
  installDashboardInteractions();
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
      currencyConversion: model.currencyConversion,
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
    const pair = currencyPair(payload);
    if (pair.fxSymbol) setLoadingDetail(`Loading ${pair.fxSymbol} · ${pair.financialCurrency} statements → ${pair.quoteCurrency} prices`);
    const fx = await fetchFxRates(workerUrl, pair);
    const model = buildDashboardModel(payload, ticker, fx);
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
