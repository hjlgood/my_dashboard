import { dom } from "./dom.js";

export function installDashboardInteractions() {
  if (document.body.dataset.dashboardInteractionsInstalled === "true") return;
  document.body.dataset.dashboardInteractionsInstalled = "true";

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

  // Anchor targets scroll below the sticky control dock.
  const dock = document.querySelector(".control-dock");
  const updateDockOffset = () => {
    const measured = dock?.getBoundingClientRect().height || 96;
    const offset = Math.ceil(measured + (window.innerWidth <= 760 ? 6 : 12));
    document.documentElement.style.setProperty("--control-dock-offset", `${offset}px`);
  };
  updateDockOffset();
  if (dock && typeof window.ResizeObserver === "function") new window.ResizeObserver(updateDockOffset).observe(dock);
}

export let mobileDockFrame = null;

export function updateMobileDockState() {
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

export function scheduleMobileDockUpdate() {
  if (mobileDockFrame !== null) return;
  mobileDockFrame = requestAnimationFrame(updateMobileDockState);
}

export function installMobileDockBehavior() {
  if (document.body.dataset.mobileDockInstalled === "true") return;
  document.body.dataset.mobileDockInstalled = "true";
  window.addEventListener("scroll", scheduleMobileDockUpdate, { passive: true });
  window.addEventListener("resize", scheduleMobileDockUpdate);
  dom.workerSettings.addEventListener("toggle", scheduleMobileDockUpdate);
  scheduleMobileDockUpdate();
}
