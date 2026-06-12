/**
 * Projection: raw vessel-details payload  ->  emission_eu_ets widget shape.
 *
 * Like the CII projection, this validates against the widget's own Zod schema, so a
 * shape drift throws loudly at request time instead of rendering wrong data.
 *
 * Source: GET {EMISSIONS_BASE_URL}/vessel-details/<imo>?year=<year> -> vesselEuEtsExposure.
 * Target: zap-widgets/src/emission/schema/emission-eu-ets.ts (emissionEuEtsInputSchema).
 */
import { emissionEuEtsInputSchema } from "../../../../zap-widgets/src/emission/schema/emission-eu-ets.js";

import { euEtsSummary } from "./vessel-details.js";

import type { RawJson } from "../westship.js";

type EmissionEuEtsData = (typeof emissionEuEtsInputSchema)["_zod"]["output"];

type ProjectArgs = { vesselName?: string | null; year: number };

export function projectEuEts(raw: RawJson, args: ProjectArgs): EmissionEuEtsData {
  // Fast path: already widget-shaped (covers the fixture + any pre-projected source).
  const passthrough = emissionEuEtsInputSchema.safeParse(raw);
  if (passthrough.success) return passthrough.data;

  const ets = euEtsSummary(raw, args.year);
  const mapped = {
    vesselName: args.vesselName ?? null,
    year: ets.year,
    coveragePct: ets.coveragePct,
    exposureEuas: ets.exposureEuas,
    totalEuaCostEur: ets.totalEuaCostEur,
  };

  // Lockstep guard: throws if the projection drifts from the widget schema.
  return emissionEuEtsInputSchema.parse(mapped);
}
