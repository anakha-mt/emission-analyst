/**
 * Projections for the two single-purpose CII chart widgets — raw
 * emission-analytics `/vessel-cii` JSON -> the widgets' own Zod-validated shapes.
 *
 *   - get_cii_rating_distribution -> cii_rating_distribution widget
 *       a flat A–E list of every rated vessel (fleet distribution view).
 *   - get_vessel_cii_forecast     -> cii_forecast_chart widget
 *       one vessel's attained-AER trajectory + A–E boundary bands per year.
 *
 * The rating distribution feeds off `/vessel-cii`; the forecast additionally uses
 * the vessel-particulars-api-2 sibling service (draught + consumption model) to
 * build the per-speed CII curve. Each `project*` shapes records into a widget's
 * data and `.parse()`s it against that widget's schema (imported from zap-widgets
 * — a hard lockstep guard).
 *
 * The speed→CII curve mirrors the friend's tool-server: for each speed in a sweep
 * we evaluate consumption, derive the AER (DWT/CF math), and bucket it into A–E
 * against each future year's required CII. If the particulars/consumption calls
 * return nothing (no token / 403 / failure), `speedCiiCurve` is omitted and the
 * widget falls back to drawing the regulatory boundary bands.
 */
import {
  ciiForecastDataSchema,
  ciiRatingDistributionDataSchema,
} from "../../../widgets/src/emission/schema/index.js";

import type { RawJson } from "../westship.js";
import type { VesselCiiRecord } from "./vessel-cii.js";

// --- shared grade helpers ---------------------------------------------------

type CiiGrade = "A" | "B" | "C" | "D" | "E";
const GRADE_SET = new Set<string>(["A", "B", "C", "D", "E"]);

/** Normalise a raw rating to an A–E grade, or null if outside the band. */
function toGrade(rating: string | null | undefined): CiiGrade | null {
  const up = (rating ?? "").trim().toUpperCase();
  return GRADE_SET.has(up) ? (up as CiiGrade) : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// --- get_cii_rating_distribution --------------------------------------------

type CiiRatingDistributionData = (typeof ciiRatingDistributionDataSchema)["_zod"]["output"];

/**
 * Project vessel-cii records into the cii_rating_distribution widget shape: a flat
 * `{ vesselName, ciiRating }` list of every rated vessel. Vessels outside A–E
 * (null / "N/A") are dropped — the widget only buckets A–E.
 */
export function projectCiiRatingDistribution(
  records: VesselCiiRecord[],
  args: { year: number },
): CiiRatingDistributionData {
  const vessels = records
    .map((r) => ({ vesselName: r.name, ciiRating: toGrade(r.rating) }))
    .filter((v): v is { vesselName: string; ciiRating: CiiGrade } => v.ciiRating !== null);

  return ciiRatingDistributionDataSchema.parse({
    title: `Fleet CII Ratings ${args.year}`,
    vessels,
  });
}

// --- get_vessel_cii_forecast ------------------------------------------------

/**
 * IMO-defined boundary ratios relative to the required CII (the C/D boundary).
 * Fixed by regulation and applied uniformly across vessel segments — same ratios
 * the friend's tool-server uses to draw the A/B/C/D/E bands.
 */
const BOUNDARY_RATIOS = { AB: 0.65, BC: 0.85, CD: 1.0, DE: 1.15 } as const;

type CiiForecastData = (typeof ciiForecastDataSchema)["_zod"]["output"];
type ForecastYear = CiiForecastData["years"][number];

/** A normalised per-vessel forecast record (the rich fields `/vessel-cii` carries). */
export type ForecastVessel = {
  imo: number;
  name: string;
  segment: string | null;
  dwt: number;
  aer: number | null;
  rating: string | null;
  requiredCii: { year: number; aer: number } | null;
  futures: { year: number; aer: number; rating: string | null }[];
  prevYear: { attainedYear: number; attainedAer: number | null; attainedRating: string | null; requiredAer: number } | null;
};

/** The forecast-relevant fields we read off each raw `/vessel-cii` item (partial). */
type ForecastApiItem = {
  imo?: number;
  vesselName?: string;
  segment?: string | null;
  deadWeight?: number; // /vessel-cii names DWT `deadWeight` (not `dwt`)
  dwt?: number; // tolerated fallback if a gateway uses the short name
  aer?: number | null;
  rating?: string | null;
  requiredCii?: { year?: number; aer?: number; rating?: string | null } | null;
  futureCiiAndRatings?: { year?: number; aer?: number; rating?: string | null }[] | null;
  previousYearCiiAndRating?: {
    attained?: { year?: number; aer?: number | null; rating?: string | null } | null;
    required?: { year?: number; aer?: number } | null;
  } | null;
};

/** Pull the rich per-vessel forecast records out of a raw `/vessel-cii` response. */
export function extractForecastVessels(raw: RawJson): ForecastVessel[] {
  const data = (raw?.["data"] as ForecastApiItem[] | undefined) ?? [];
  return data.map((v) => {
    const req =
      v.requiredCii && v.requiredCii.year != null && v.requiredCii.aer != null
        ? { year: Number(v.requiredCii.year), aer: Number(v.requiredCii.aer) }
        : null;

    const futures = (v.futureCiiAndRatings ?? [])
      .filter((f) => f.year != null && f.aer != null)
      .map((f) => ({ year: Number(f.year), aer: Number(f.aer), rating: f.rating ?? null }));

    const prev = v.previousYearCiiAndRating;
    const prevYear =
      prev?.attained?.year != null && prev.required?.aer != null
        ? {
            attainedYear: Number(prev.attained.year),
            attainedAer: prev.attained.aer ?? null,
            attainedRating: prev.attained.rating ?? null,
            requiredAer: Number(prev.required.aer),
          }
        : null;

    return {
      imo: Number(v.imo ?? 0),
      name: v.vesselName ?? "",
      segment: v.segment ?? null,
      dwt: Number(v.deadWeight ?? v.dwt ?? 0),
      aer: v.aer ?? null,
      rating: v.rating ?? null,
      requiredCii: req,
      futures,
      prevYear,
    };
  });
}

/** Build one forecast year entry from a required-CII AER, applying the fixed IMO ratios. */
function buildYearEntry(
  year: number,
  requiredAer: number,
  attainedAer: number | null,
  rating: string | null,
): ForecastYear {
  return {
    year,
    attainedAer,
    rating,
    boundaryAB: round2(requiredAer * BOUNDARY_RATIOS.AB),
    boundaryBC: round2(requiredAer * BOUNDARY_RATIOS.BC),
    boundaryCD: round2(requiredAer * BOUNDARY_RATIOS.CD),
    boundaryDE: round2(requiredAer * BOUNDARY_RATIOS.DE),
  };
}

/** Resolve a vessel in a snapshot by IMO (preferred) or case-insensitive name. */
export const findForecastVessel = (
  list: ForecastVessel[],
  args: { imo?: number; vesselName?: string },
): ForecastVessel | undefined =>
  args.imo != null
    ? list.find((v) => v.imo === args.imo)
    : args.vesselName != null
      ? list.find((v) => v.name.toLowerCase() === args.vesselName!.toLowerCase())
      : undefined;

// --- speed → CII curve (vessel-particulars-api-2) ---------------------------

/** Tank-to-wake CO2 factor for HFO (t CO2 / t fuel) — same constant the friend uses. */
const CF_HFO = 3.114;
/** Speed sweep evaluated against the consumption model (knots). */
const SPEED_MIN = 3.5;
const SPEED_MAX = 30;
const SPEED_STEP = 0.5;
/** Draft fallback when vessel particulars are unavailable. */
const DEFAULT_DRAFT = 10;

/** One speed/draft point posted to /v1/consumption/evaluate-consumption. */
export type ConsumptionEvaluation = {
  average_draft: number;
  base_model: string;
  course: number;
  current_direction: number;
  current_intensity: number;
  direction_of_swell_waves: number;
  direction_of_wind_waves: number;
  fuel_type: string;
  imo: number;
  speed_over_ground: number;
  swell_wave_height: number;
  swell_wave_period: number;
  timestamp: string;
  wind_direction: number;
  wind_intensity: number;
  wind_wave_height: number;
  wind_wave_period: number;
};

/**
 * Build the consumption-evaluation request body: a sweep of speeds (3.5→30 kn) at
 * the vessel's draft, with fixed weather defaults — mirrors the friend's request.
 * `evaluations[i].speed_over_ground` aligns to `consumptions[i]` in the response.
 */
export function buildConsumptionRequest(imo: number, maxDraught: number | null): {
  baseline_choices: string[];
  evaluations: ConsumptionEvaluation[];
  fuel_model_version: string;
  model_selection: string;
} {
  const averageDraft = maxDraught != null && maxDraught > 0 ? maxDraught : DEFAULT_DRAFT;
  const evaluations: ConsumptionEvaluation[] = [];
  for (let speed = SPEED_MIN; speed <= SPEED_MAX; speed = Math.round((speed + SPEED_STEP) * 10) / 10) {
    evaluations.push({
      average_draft: averageDraft,
      base_model: "general",
      course: 355,
      current_direction: 12,
      current_intensity: 0.05,
      direction_of_swell_waves: 60,
      direction_of_wind_waves: 40,
      fuel_type: "HFO",
      imo,
      speed_over_ground: speed,
      swell_wave_height: 2,
      swell_wave_period: 1,
      timestamp: "2023-01-01T00:00:00Z",
      wind_direction: 155,
      wind_intensity: 12,
      wind_wave_height: 2,
      wind_wave_period: 1,
    });
  }
  return {
    baseline_choices: ["cleanest_state_sisters"],
    evaluations,
    fuel_model_version: "v4-8",
    model_selection: "override",
  };
}

/** Determine the CII grade (A–E) for an AER against a year's required CII. */
function getRating(aer: number, requiredAer: number): CiiGrade {
  if (aer <= requiredAer * BOUNDARY_RATIOS.AB) return "A";
  if (aer <= requiredAer * BOUNDARY_RATIOS.BC) return "B";
  if (aer <= requiredAer * BOUNDARY_RATIOS.CD) return "C";
  if (aer <= requiredAer * BOUNDARY_RATIOS.DE) return "D";
  return "E";
}

/**
 * Project a vessel's CII forecast into the cii_forecast_chart widget shape.
 *
 * `current` is the current-year fleet snapshot (previous year + current + future
 * projections); `older` is the snapshot two years back, used only to extend the
 * historical tail (e.g. 2023/2024). Years are merged, sorted, and de-duplicated
 * (an entry with an attained AER wins over a boundary-only one for the same year).
 *
 * `consumptions` (speed → fuel consumption, from the consumption-evaluation API)
 * are converted to the per-speed AER/CII curve when present; when empty the
 * `speedCiiCurve` is omitted and the widget falls back to boundary bands.
 */
export function projectVesselCiiForecast(
  current: ForecastVessel[],
  older: ForecastVessel[],
  args: { imo?: number; vesselName?: string; consumptions?: { speed: number; consumption: number }[] },
): CiiForecastData {
  const vessel = findForecastVessel(current, args);

  // No vessel / no required-CII anchor -> a valid empty forecast (widget renders nothing).
  if (!vessel || !vessel.requiredCii) {
    return ciiForecastDataSchema.parse({
      title: "CII Forecast",
      vesselName: vessel?.name ?? args.vesselName ?? "",
      imo: vessel?.imo ?? args.imo ?? 0,
      segment: vessel?.segment ?? "Unknown",
      years: [],
    });
  }

  const olderVessel = findForecastVessel(older, { imo: vessel.imo });
  const years: ForecastYear[] = [];

  // Older historical tail (e.g. 2023 + 2024).
  if (olderVessel) {
    if (olderVessel.prevYear) {
      years.push(
        buildYearEntry(
          olderVessel.prevYear.attainedYear,
          olderVessel.prevYear.requiredAer,
          olderVessel.prevYear.attainedAer,
          olderVessel.prevYear.attainedRating,
        ),
      );
    }
    if (olderVessel.requiredCii) {
      years.push(buildYearEntry(olderVessel.requiredCii.year, olderVessel.requiredCii.aer, olderVessel.aer, olderVessel.rating));
    }
  }

  // Previous year + current year + future projections from the current snapshot.
  if (vessel.prevYear) {
    years.push(
      buildYearEntry(vessel.prevYear.attainedYear, vessel.prevYear.requiredAer, vessel.prevYear.attainedAer, vessel.prevYear.attainedRating),
    );
  }
  years.push(buildYearEntry(vessel.requiredCii.year, vessel.requiredCii.aer, vessel.aer, vessel.rating));
  for (const f of vessel.futures) {
    years.push(buildYearEntry(f.year, f.aer, null, null));
  }

  // Dedupe by year, preferring an entry that carries an attained AER.
  const byYear = new Map<number, ForecastYear>();
  for (const y of years) {
    const existing = byYear.get(y.year);
    if (!existing || (existing.attainedAer == null && y.attainedAer != null)) byYear.set(y.year, y);
  }
  const dedupedYears = [...byYear.values()].sort((a, b) => a.year - b.year);

  // Per-speed CII curve: AER = (consumption × CF × 10^6) / (DWT × speed × 24),
  // bucketed into A–E against each future year's required CII. Only when we have
  // both consumption points and the future required-CII anchors to rate against.
  const speedCiiCurve =
    args.consumptions && args.consumptions.length > 0 && vessel.dwt > 0 && vessel.futures.length > 0
      ? args.consumptions
          .filter((c) => c.speed > 0)
          .map((c) => {
            const aer = (c.consumption * CF_HFO * 1e6) / (vessel.dwt * c.speed * 24);
            return {
              speed: c.speed,
              aer: round2(aer),
              yearRatings: vessel.futures.map((f) => ({ year: f.year, rating: getRating(aer, f.aer) })),
            };
          })
      : [];

  return ciiForecastDataSchema.parse({
    title: "CII Forecast",
    vesselName: vessel.name,
    imo: vessel.imo,
    segment: vessel.segment ?? "Unknown",
    years: dedupedYears,
    ...(speedCiiCurve.length > 0 ? { speedCiiCurve } : {}),
  });
}
