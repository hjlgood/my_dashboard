import { dom } from "./dom.js";
import { scheduleMobileDockUpdate } from "./layout.js";

export let html2CanvasPromise = null;
export let exportStatusTimer = null;
export let exportBusy = false;

export function setExportStatus(message, state = "") {
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

export function updateExportButtonState() {
  const disabled = exportBusy || dom.button?.classList.contains("loading");
  [dom.savePngButton, dom.saveHtmlButton].forEach((button) => {
    if (!button) return;
    button.disabled = disabled;
    button.setAttribute("aria-busy", String(exportBusy));
  });
}

export function setExportBusy(busy) {
  exportBusy = busy;
  updateExportButtonState();
}

export function loadHtml2Canvas() {
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

export function exportFileStem() {
  const ticker = (dom.ticker?.value || "dashboard").trim().toUpperCase()
    .replace(/[^A-Z0-9.^=-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "dashboard";
  const now = new Date();
  const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("");
  return `${ticker}-dashboard-${date}`;
}

export function downloadBlob(blob, filename) {
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

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function replaceDashboardCanvasesWithImages() {
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

export async function withExportLayout(callback) {
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

export async function saveDashboardPng() {
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

export async function snapshotStylesheet() {
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

export async function createDashboardSnapshot() {
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

export async function saveDashboardHtml() {
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
