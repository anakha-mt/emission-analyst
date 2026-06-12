/**
 * Projection: raw vessel-details payload  ->  emission_fuel_consumption widget shape.
 *
 * Validates against the widget's own Zod schema (hard lockstep, like the CII projection).
 *
 * Source: GET {EMISSIONS_BASE_URL}/vessel-details/<imo>?year=<year> -> fuelConsumption.
 * Target: zap-widgets/src/emission/schema/fuel-consumption.ts (emissionFuelConsumptionInputSchema).
 */
import { emissionFuelConsumptionInputSchema } from "../../../widgets/src/emission/schema/fuel-consumption.js";

import { aggregateFuelLines, FUEL_CONSUMPTION_BASIS, totalCo2Mt } from "./vessel-details.js";

import type { RawJson } from "../westship.js";

type EmissionFuelConsumptionData = (typeof emissionFuelConsumptionInputSchema)["_zod"]["output"];

type ProjectArgs = { vesselName?: string | null; year: number };

export function projectFuelConsumption(raw: RawJson, args: ProjectArgs): EmissionFuelConsumptionData {
  // Fast path: already widget-shaped (covers the fixture + any pre-projected source).
  const passthrough = emissionFuelConsumptionInputSchema.safeParse(raw);
  if (passthrough.success) return passthrough.data;

  const mapped = {
    vesselName: args.vesselName ?? null,
    imo: typeof raw["imo"] === "number" ? (raw["imo"] as number) : Number(raw["imo"]),
    fuelConsumption: aggregateFuelLines(raw),
    fuelConsumptionBasis: FUEL_CONSUMPTION_BASIS,
    totalCo2EmissionsMt: totalCo2Mt(raw),
  };

  // Lockstep guard: throws if the projection drifts from the widget schema.
  return emissionFuelConsumptionInputSchema.parse(mapped);
}
