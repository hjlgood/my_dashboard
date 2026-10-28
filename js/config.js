export const MODEL = Object.freeze({
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

export const COLORS = Object.freeze({
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

export const BAND_COLORS = ["#637c86", "#77949e", "#d6dfe2", "#9a8d7d", "#7c6d63"];
export const BAND_LINE_TYPES = ["dotted", "dashed", "solid", "dashed", "dotted"];
export const BAND_SMOOTH = 0.80;
export const NUMERIC_FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
export const CHART_GRID = Object.freeze({ left: 74, right: 84, top: 42, bottom: 56 });
export const RETURN_RAIL = Object.freeze({ minimumMagnitude: 0.50, step: 0.25, maximumMagnitude: 2.00 });
export const ENDPOINT_IMPACTS = Object.freeze({
  chart: "Price history and charts 1–3",
  fundamentals: "Chart 4 and historical drivers",
  quote: "Masthead, current price and metrics",
  analysis: "Valuation rail, bands and scenarios",
});
export const HORIZONTAL_CROSSHAIR_ID = "manual-horizontal-crosshair";
