/**
 * Projection: raw Westship CII payload  ->  emission_analytics widget shape.
 *
 * This is the deterministic "data -> fields" matching layer. It cherry-picks and
 * transforms only the fields the emission_analytics widget needs, then validates
 * the result against the widget's own Zod schema. `.parse()` runs on the schema's
 * own runtime (zap-widgets' zod), so it is a hard lockstep guarantee: if the shape
 * ever drifts from the widget, this throws loudly instead of rendering wrong data.
 *
 * Source endpoint (year-to-date CII graph):
 *   GET {EMISSIONS_BASE_URL}/year-to-date-cii-for-graph/<imo>?year=<year>
 *   -> { graphData: [{ date: "Jan 1", curCii, prevCii, curCiiRating, prevCiiRating }, ...],
 *        unAppliedCorrectionCii, appliedCorrectionCii, requiredCii, correctionData, ... }
 *
 * Target output shape is pinned by:
 *   zap-widgets/src/emission/schema/emission-analytics.ts (emissionAnalyticsInputSchema)
 *   zap-widgets/src/emission/components/westship-cii.fixture.json (worked example)
 */
import { emissionAnalyticsInputSchema } from "../../../../zap-widgets/src/emission/schema/emission-analytics.js";

import type { RawJson } from "../westship.js";

// The widget's data type, derived straight from its schema — no re-declaration.
type EmissionAnalyticsData = (typeof emissionAnalyticsInputSchema)["_zod"]["output"];

type ProjectArgs = {
  vesselName?: string | null;
  year: number;
};

type GraphPoint = {
  date: string; // "Jan 1" — month-abbrev + day, no year
  curCii: number | null;
  prevCii: number | null;
  curCiiRating: string | null;
  prevCiiRating: string | null;
};

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const pad = (n: number) => String(n).padStart(2, "0");

/** "Jun 8" + 2026 -> "2026-06-08T00:00:00Z". Returns null for labels invalid in that year (e.g. Feb 29 non-leap). */
function labelToIso(label: string, year: number): string | null {
  const [mon, dayStr] = label.trim().split(/\s+/);
  const month = MONTHS[mon];
  const day = Number(dayStr);
  if (month === undefined || !Number.isFinite(day)) return null;
  // Reject overflow (e.g. Feb 29 in a non-leap year rolls to Mar 1).
  const probe = new Date(Date.UTC(year, month, day));
  if (probe.getUTCMonth() !== month) return null;
  return `${year}-${pad(month + 1)}-${pad(day)}T00:00:00Z`;
}

/** "c" -> "C". Anything unexpected falls back to "C" (mid band) so the schema enum still passes. */
function normaliseRating(r: string | null | undefined): "A" | "B" | "C" | "D" | "E" {
  const up = (r ?? "").toUpperCase();
  return up === "A" || up === "B" || up === "C" || up === "D" || up === "E" ? up : "C";
}

/**
 * Map a raw Westship CII graph response into the emission_analytics widget shape.
 *
 * `series`/`startDate`/`endDate`/`defaultYear` come from `graphData`; `correctionFactors`
 * from the un/applied correction CII + `correctionData`; `boundariesByYear` is derived
 * from the response's `requiredCii`. All values are live — no hardcoded figures.
 */
export function projectEmissionAnalytics(raw: RawJson, args: ProjectArgs): EmissionAnalyticsData {
  // Fast path: already widget-shaped (covers the fixture + any pre-projected source).
  const passthrough = emissionAnalyticsInputSchema.safeParse(raw);
  if (passthrough.success) return passthrough.data;

  const graphData = (raw["graphData"] as GraphPoint[] | undefined) ?? [];
  const curYear = args.year;
  const prevYear = args.year - 1;

  // ── series: current year from curCii, previous year from prevCii ──────────
  const curPoints = graphData
    .filter((p) => p.curCii != null)
    .map((p) => ({ date: labelToIso(p.date, curYear), cii: p.curCii as number }))
    .filter((p): p is { date: string; cii: number } => p.date !== null);

  const prevPoints = graphData
    .filter((p) => p.prevCii != null)
    .map((p) => ({ date: labelToIso(p.date, prevYear), cii: p.prevCii as number }))
    .filter((p): p is { date: string; cii: number } => p.date !== null);

  const series = [
    { year: curYear, points: curPoints },
    ...(prevPoints.length ? [{ year: prevYear, points: prevPoints }] : []),
  ];

  // ── date range: Jan 1 of the current year .. last attained (cur) point ────
  const startDate = `${curYear}-01-01T00:00:00Z`;
  const endDate = curPoints.at(-1)?.date ?? startDate;

  // ── latest attained CII (fallback when the correction fields are absent) ──
  const lastCur = graphData.filter((p) => p.curCii != null).at(-1);
  const latestValue = (lastCur?.curCii as number | undefined) ?? 0;
  const latestRating = normaliseRating(lastCur?.curCiiRating);

  // Before/after correction come from the API (+ their ratings). Corrections deduct
  // fuel/CO2, which LOWERS CII — so `appliedCorrectionCii` (corrections applied) is the
  // better "after" value and `unAppliedCorrectionCii` (none applied) is the worse
  // "before" value. Fall back to the latest attained CII when a field is missing.
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const beforeCii = num(raw["unAppliedCorrectionCii"]);
  const afterCii = num(raw["appliedCorrectionCii"]);
  const beforeValue = beforeCii ?? latestValue;
  const afterValue = afterCii ?? latestValue;
  const beforeRating =
    beforeCii != null ? normaliseRating(raw["unAppliedCorrectionCiiRating"] as string | null) : latestRating;
  const afterRating =
    afterCii != null ? normaliseRating(raw["appliedCorrectionCiiRating"] as string | null) : latestRating;

  // Total consumption / CO2 deducted = sum of every correction's deductibleConsumption /
  // deductibleEmission from the live `correctionData` (not-applied entries carry 0, so
  // summing all is safe).
  type CorrectionEntry = {
    correctedConsumptionDetails?: { deductibleConsumption?: number | null } | null;
    correctedEmissionDetails?: { deductibleEmission?: number | null } | null;
  };
  const correctionData = Array.isArray(raw["correctionData"]) ? (raw["correctionData"] as CorrectionEntry[]) : [];
  const totalConsumptionDeductedMt = correctionData.reduce(
    (sum, c) => sum + (c.correctedConsumptionDetails?.deductibleConsumption ?? 0),
    0,
  );
  const totalCo2DeductedMt = correctionData.reduce(
    (sum, c) => sum + (c.correctedEmissionDetails?.deductibleEmission ?? 0),
    0,
  );

  // Rating boundaries: required CII comes straight from the live response — no hardcoded
  // value. The API doesn't return the A–E band edges, so they're derived from requiredCii
  // via the standard CII rating multipliers (formula, not vessel data). If the response
  // lacks requiredCii the projection throws and the handler falls back to the fixture.
  const requiredCii = num(raw["requiredCii"]);
  if (requiredCii == null) {
    throw new Error("emission-analytics response is missing requiredCii — cannot derive CII boundaries.");
  }
  const deriveBoundaries = (year: number) => ({
    year,
    requiredCii,
    aMax: Number((requiredCii * 0.82).toFixed(3)),
    bMax: Number((requiredCii * 0.93).toFixed(3)),
    cMax: Number((requiredCii * 1.08).toFixed(3)),
    dMax: Number((requiredCii * 1.19).toFixed(3)),
  });
  const boundariesByYear = [deriveBoundaries(curYear), ...(prevPoints.length ? [deriveBoundaries(prevYear)] : [])];

  const correctionFactors = {
    beforeCorrection: { rating: beforeRating, value: beforeValue },
    afterCorrection: { rating: afterRating, value: afterValue },
    totalConsumptionDeductedMt,
    totalCo2DeductedMt,
  };

  const mapped = {
    vesselName: args.vesselName ?? null,
    startDate,
    endDate,
    defaultYear: curYear,
    series,
    boundariesByYear,
    correctionFactors,
  };

  // Lockstep guard: throws if the projection drifts from the widget schema.
  return emissionAnalyticsInputSchema.parse(mapped);
}
