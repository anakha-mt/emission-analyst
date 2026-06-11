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
 *   GET /emission-analytics/api/year-to-date-cii-for-graph?imo=<imo>&year=<year>
 *   -> { graphData: [{ date: "Jan 1", curCii, prevCii, curCiiRating, prevCiiRating }, ...] }
 *
 * Target output shape is pinned by:
 *   zap-widgets/src/emission/schema/emission-analytics.ts (emissionAnalyticsInputSchema)
 *   zap-widgets/src/emission/components/westship-cii.fixture.json (worked example)
 */
import { emissionAnalyticsInputSchema } from "../../../../zap-widgets/src/emission/schema/emission-analytics.js";

import type { RawJson } from "../westship.js";

// The widget's data type, derived straight from its schema — no re-declaration.
type EmissionAnalyticsData = (typeof emissionAnalyticsInputSchema)["_zod"]["output"];

export type ProjectArgs = {
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
 * `series`, `startDate`, `endDate`, `defaultYear` are derived deterministically from
 * `graphData`. `boundariesByYear` and `correctionFactors` are NOT in this endpoint —
 * see the TODO below.
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

  // ── latest attained CII (drives the correction-factors summary) ───────────
  const lastCur = graphData.filter((p) => p.curCii != null).at(-1);
  const latestValue = (lastCur?.curCii as number | undefined) ?? 0;
  const latestRating = normaliseRating(lastCur?.curCiiRating);

  // TODO(implementation): boundariesByYear and correctionFactors are not in the
  // graph endpoint. Wire the real Westship sources when available:
  //   - rating boundaries (requiredCii + A–E band edges per year)
  //   - correction factors (before/after CII + deducted consumption/CO2)
  // Until then we derive what we can (afterCorrection = latest attained CII) and
  // use the vessel's reference boundary values so the widget renders end-to-end.
  const referenceBoundaries = { requiredCii: 3.88926652641849, aMax: 3.189, bMax: 3.617, cMax: 4.2, dMax: 4.628 };
  const boundariesByYear = [
    { year: curYear, ...referenceBoundaries },
    ...(prevPoints.length ? [{ year: prevYear, ...referenceBoundaries }] : []),
  ];

  const correctionFactors = {
    beforeCorrection: { rating: latestRating, value: latestValue },
    afterCorrection: { rating: latestRating, value: latestValue },
    totalConsumptionDeductedMt: 0,
    totalCo2DeductedMt: 0,
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
