/**
 * Shared mappers for the vessel-details upstream payload.
 *
 *   GET {EMISSIONS_BASE_URL}/vessel-details/<imo>?year=<year>
 *
 * One upstream response feeds three widgets (EU ETS, fuel consumption, fleet
 * summary). The slices each widget needs overlap, so the per-section mappers live
 * here and are imported by the individual projections.
 */
import { normaliseRating } from "./emission-analytics.js";

import type { RawJson } from "../westship.js";

/** A widget fuel-consumption line — shared shape across fuel-consumption + fleet-summary. */
export type FuelLine = {
  fuelType: string;
  consumptionMt: number;
  co2ConversionFactor: number;
  co2Mt: number;
};

/** Coerce to a finite number, else 0. vessel-details numeric fields are nullable. */
const num0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A raw fuel-wise consumption entry, split per engine type upstream. */
type FuelWiseEntry = {
  fuelType?: string | null;
  fuelConsumption?: number | null;
  co2ConversionFactor?: number | null;
  co2Emission?: number | null;
};

/**
 * Aggregate `fuelConsumption.fuelWiseConsumption` by fuel type. Upstream splits each
 * fuel across engine types (Main / Auxiliary / …); the widget wants one line per fuel,
 * so consumption and CO2 are summed and the conversion factor is taken from any entry
 * of that fuel (it's constant per fuel type).
 */
export function aggregateFuelLines(raw: RawJson): FuelLine[] {
  const fc = raw["fuelConsumption"] as { fuelWiseConsumption?: FuelWiseEntry[] } | undefined;
  const entries = Array.isArray(fc?.fuelWiseConsumption) ? fc.fuelWiseConsumption : [];

  const byFuel = new Map<string, FuelLine>();
  for (const e of entries) {
    const fuelType = e.fuelType ?? "Unknown";
    const existing = byFuel.get(fuelType);
    if (existing) {
      existing.consumptionMt += num0(e.fuelConsumption);
      existing.co2Mt += num0(e.co2Emission);
    } else {
      byFuel.set(fuelType, {
        fuelType,
        consumptionMt: num0(e.fuelConsumption),
        co2ConversionFactor: num0(e.co2ConversionFactor),
        co2Mt: num0(e.co2Emission),
      });
    }
  }
  return [...byFuel.values()];
}

/** Total CO2 for the IMO, from the upstream aggregate. */
export function totalCo2Mt(raw: RawJson): number {
  const fc = raw["fuelConsumption"] as { totalCo2Emission?: number | null } | undefined;
  return num0(fc?.totalCo2Emission);
}

/** No basis label exists upstream — the figures are tank-to-wake (matches the fixtures). */
export const FUEL_CONSUMPTION_BASIS = "Tank to Wake";

/** EU ETS exposure slice, shared by the eu-ets widget and the fleet-summary `euEts` block. */
export function euEtsSummary(raw: RawJson, fallbackYear: number) {
  const ets = (raw["vesselEuEtsExposure"] ?? {}) as Record<string, unknown>;
  const year = ets["emissionAllowanceYear"];
  return {
    year: typeof year === "number" ? year : fallbackYear,
    coveragePct: num0(ets["emissionAllowancePercentage"]),
    exposureEuas: num0(ets["totalEuAllowances"]),
    totalEuaCostEur: num0(ets["totalEuaCost"]),
  };
}

/**
 * Voyage performance slice for the fleet-summary widget. `averageSpeed` may be a
 * scalar (overall), an object split into laden/ballast, or null.
 */
export function performanceSummary(raw: RawJson) {
  const perf = (raw["performance"] ?? {}) as Record<string, unknown>;
  const avg = perf["averageSpeed"];
  let laden = 0;
  let ballast = 0;
  if (typeof avg === "number") {
    laden = ballast = avg;
  } else if (avg && typeof avg === "object") {
    laden = num0((avg as Record<string, unknown>)["laden"]);
    ballast = num0((avg as Record<string, unknown>)["ballast"]);
  }
  return {
    distanceSailedNm: num0(perf["distanceSailed"]),
    timeUnderwayHours: num0(perf["timeUnderway"]),
    averageSpeedLadenKn: laden,
    averageSpeedBallastKn: ballast,
  };
}

/**
 * Attained-CII slice for the fleet-summary widget. The 30-day trend percentage is a
 * magnitude upstream with direction flags; the widget convention is "positive = CII
 * increased (worse)", so `up` keeps the sign and `down` negates it.
 */
export function attainedCiiSummary(raw: RawJson) {
  const aer = (raw["aer"] ?? {}) as Record<string, unknown>;
  const attained = ((aer["cii"] as Record<string, unknown>)?.["attained"] ?? {}) as Record<string, unknown>;
  const comparison = (aer["comparison"] ?? null) as Record<string, unknown> | null;

  const pct = num0(comparison?.["percentage"]);
  const changePct = comparison?.["down"] === true ? -pct : pct;

  return {
    value: num0(attained["cii"]),
    rating: normaliseRating(attained["rating"] as string | null | undefined),
    changePctVsPrevious30Days: changePct,
  };
}
