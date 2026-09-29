// Central pricing table for Kashier checkout.
// Amounts are in MAJOR units (dollars / pounds), not cents/piasters.
// Kashier accepts a fractional string like "9.00" or "449.00".

import type { Plan } from "./quota.server";

export type Currency = "USD" | "EGP";
export type PayablePlan = Exclude<Plan, "free">;

export type PriceRow = {
  amount: number;      // major units
  currency: Currency;
  label: string;       // e.g. "$9/mo"
  credits: number;     // matching monthly allotment
  planLabel: string;
};

const CATALOG: Record<PayablePlan, Record<Currency, PriceRow>> = {
  pro: {
    USD: { amount: 10,   currency: "USD", label: "$10/mo",     credits: 3_000,  planLabel: "Supporter" },
    EGP: { amount: 499, currency: "EGP", label: "499 EGP/mo", credits: 3_000,  planLabel: "Supporter" },
  },
  aplus: {
    USD: { amount: 20,  currency: "USD", label: "$20/mo",    credits: 15_000, planLabel: "Supporter+" },
    EGP: { amount: 999, currency: "EGP", label: "999 EGP/mo", credits: 15_000, planLabel: "Supporter+" },
  },
};

export function detectCurrencyFromRequest(request: Request): Currency {
  const country =
    request.headers.get("cf-ipcountry") ||
    request.headers.get("x-vercel-ip-country") ||
    "";
  if (country.toUpperCase() === "EG") return "EGP";
  const lang = (request.headers.get("accept-language") || "").toLowerCase();
  if (lang.includes("-eg") || lang.startsWith("ar")) return "EGP";
  return "USD";
}

export function getPrice(plan: PayablePlan, currency: Currency): PriceRow {
  return CATALOG[plan][currency];
}

export function listPrices(currency: Currency) {
  return {
    currency,
    pro: getPrice("pro", currency),
    aplus: getPrice("aplus", currency),
  };
}

export function isPayablePlan(x: unknown): x is PayablePlan {
  return x === "pro" || x === "aplus";
}

export function isCurrency(x: unknown): x is Currency {
  return x === "USD" || x === "EGP";
}
