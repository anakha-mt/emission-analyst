/**
 * Projection: raw vessel-details payload  ->  emission_fleet_summary widget shape.
 *
 * The fleet-summary widget is a single-vessel emission overview (a superset of the
 * eu-ets + fuel-consumption widgets). Validates against the widget's own Zod schema
 * (hard lockstep, like the CII projection).
 *
 * Source: GET {EMISSIONS_BASE_URL}/vessel-details/<imo>?year=<year>.
 * Target: zap-widgets/src/emission/schema/fleet-summary.ts (emissionFleetSummaryInputSchema).
 */
import { emissionFleetSummaryInputSchema } from "../../../../zap-widgets/src/emission/schema/fleet-summary.js";

import {
  aggregateFuelLines,
  attainedCiiSummary,
  euEtsSummary,
  FUEL_CONSUMPTION_BASIS,
  performanceSummary,
  totalCo2Mt,
} from "./vessel-details.js";

import type { RawJson } from "../westship.js";

type EmissionFleetSummaryData = (typeof emissionFleetSummaryInputSchema)["_zod"]["output"];

type ProjectArgs = { vesselName?: string | null; year: number };

const num0 = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function projectFleetSummary(raw: RawJson, args: ProjectArgs): EmissionFleetSummaryData {
  // Fast path: already widget-shaped (covers the fixture + any pre-projected source).
  const passthrough = emissionFleetSummaryInputSchema.safeParse(raw);
  if (passthrough.success) return passthrough.data;

  const mapped = {
    vesselType: typeof raw["shipCiiType"] === "string" ? (raw["shipCiiType"] as string) : "Unknown",
    imo: typeof raw["imo"] === "number" ? (raw["imo"] as number) : Number(raw["imo"]),
    capacityDwtMt: num0(raw["dwt"]),
    iceClass: (raw["iceClass"] as string | null | undefined) ?? null,
    referenceAerCii: num0(raw["referenceCII"]),
    performance: performanceSummary(raw),
    attainedCii: attainedCiiSummary(raw),
    euEts: euEtsSummary(raw, args.year),
    fuelConsumption: aggregateFuelLines(raw),
    fuelConsumptionBasis: FUEL_CONSUMPTION_BASIS,
    totalCo2EmissionsMt: totalCo2Mt(raw),
  };

  // Lockstep guard: throws if the projection drifts from the widget schema.
  return emissionFleetSummaryInputSchema.parse(mapped);
}
