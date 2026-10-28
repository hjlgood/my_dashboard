import { finite } from "./utils.js";

export function formatNumber(value, digits = 2) {
  return finite(value)
    ? value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : "N/A";
}

export function formatPercent(value, digits = 1, signed = false) {
  if (!finite(value)) return "N/A";
  const sign = signed && value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function formatMultiple(value, digits = 1) {
  return finite(value) ? `${value.toFixed(digits)}x` : "N/A";
}

export function currencySymbol(currency) {
  return ({ USD: "$", EUR: "€", GBP: "£", JPY: "¥", KRW: "₩", CNY: "¥", CAD: "C$", AUD: "A$" })[currency] || `${currency || ""} `;
}

export function formatMoney(value, currency, digits = 2) {
  return finite(value) ? `${currencySymbol(currency)}${formatNumber(value, digits)}` : "N/A";
}

export function formatCompactMoney(value, currency) {
  if (!finite(value)) return "N/A";
  const abs = Math.abs(value);
  const units = [[1e12, "T"], [1e9, "B"], [1e6, "M"]];
  const unit = units.find(([threshold]) => abs >= threshold);
  return unit
    ? `${currencySymbol(currency)}${(value / unit[0]).toFixed(2)}${unit[1]}`
    : formatMoney(value, currency, 0);
}

export function forwardChange(current, future) {
  return current > 0 && future > 0 ? formatPercent(future / current - 1, 1, true) : "N/A";
}
