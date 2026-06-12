/**
 * Projections for the /voyage-overview tools — raw emission-analytics JSON ->
 * the widgets' own Zod-validated shapes.
 *
 * One upstream feed (`/voyage-overview`, fetched soft in westship.ts) backs four
 * tools: voyage overview (a data list the agent reshapes into the voyage-cii /
 * vessel-voyages widgets), carbon-cost ranking, incomplete voyages, and route
 * comparison. `extractVoyageRecords` normalises the raw paged payload once; each
 * `project*` then shapes a record set into a widget's data and `.parse()`s it.
 *
 * NOTE on optional vs nullish: some widget fields are `.optional()` (undefined ok,
 * null NOT ok). For those we coalesce null -> undefined; nullish fields keep null.
 */
import { z } from "zod";

import {
  fleetRouteEmissionsDataSchema,
  incompleteVoyagesDataSchema,
  voyageCarbonCostDataSchema,
} from "../../../../zap-widgets/src/emission/schema/index.js";
import type { RawJson } from "../westship.js";

// --- raw -> clean per-voyage record -----------------------------------------

/** A normalised per-voyage record (only the fields the tools use). */
export type VoyageRecord = {
  vesselName: string;
  imo: number;
  segment: string | null;
  voyageId: string | null;
  departurePort: string | null;
  departureDate: string | null;
  arrivalPort: string | null;
  arrivalDate: string | null;
  isCompleted: boolean;
  attainedRating: string | null;
  requiredRating: string | null;
  totalDistance: number | null;
  totalConsumption: number | null;
  co2TtwEmissions: number | null;
  euas: number | null;
  liveCost: number | null;
};

/** The fields we read off each raw `/voyage-overview` item (partial — only what we use). */
type VoyageApiItem = {
  imo?: number;
  vesselName?: string;
  segment?: string | null;
  voyageId?: string | null;
  attained?: { rating?: string | null } | null;
  required?: { rating?: string | null } | null;
  departure?: { portName?: string | null; date?: string | null } | null;
  arrival?: { portName?: string | null; date?: string | null } | null;
  isCompleted?: boolean | null;
  totalDistance?: number | null;
  totalConsumption?: number | null;
  co2TtwEmissions?: number | null;
  euas?: number | null;
  liveCost?: number | null;
  // Per-fuel consumption (tonnes) — used to derive CO2 when the upstream leaves
  // co2TtwEmissions at 0 (it only fills it for EU-MRV-eligible voyages).
  hfoConsumption?: number | null;
  lfoConsumption?: number | null;
  mgoMdoConsumption?: number | null;
  lngConsumption?: number | null;
  lpgConsumption?: number | null;
};

/**
 * IMO tank-to-wake CO2 factors (t CO2 per t fuel) per fuel type. Used to derive
 * a voyage's CO2 from its fuel burn when the upstream reports co2TtwEmissions=0
 * (non-EU-MRV voyages). EU voyages keep the upstream's own figure.
 */
const CF_TTW = { hfo: 3.114, lfo: 3.151, mgoMdo: 3.206, lng: 2.75, lpg: 3.0 } as const;

/** Tank-to-wake CO2 (tonnes) computed from a voyage's per-fuel consumption breakdown. */
function co2FromFuel(v: VoyageApiItem): number {
  return (
    (v.hfoConsumption ?? 0) * CF_TTW.hfo +
    (v.lfoConsumption ?? 0) * CF_TTW.lfo +
    (v.mgoMdoConsumption ?? 0) * CF_TTW.mgoMdo +
    (v.lngConsumption ?? 0) * CF_TTW.lng +
    (v.lpgConsumption ?? 0) * CF_TTW.lpg
  );
}

/** Pull the clean per-voyage records out of a raw `/voyage-overview` response (`{ data: [...] }`). */
export function extractVoyageRecords(raw: RawJson): VoyageRecord[] {
  const data = (raw?.["data"] as VoyageApiItem[] | undefined) ?? [];
  return data.map((v) => ({
    vesselName: v.vesselName ?? "",
    imo: Number(v.imo ?? 0),
    segment: v.segment ?? null,
    voyageId: v.voyageId ?? null,
    departurePort: v.departure?.portName ?? null,
    departureDate: v.departure?.date ?? null,
    arrivalPort: v.arrival?.portName ?? null,
    arrivalDate: v.arrival?.date ?? null,
    isCompleted: Boolean(v.isCompleted),
    attainedRating: v.attained?.rating ?? null,
    requiredRating: v.required?.rating ?? null,
    totalDistance: v.totalDistance ?? null,
    totalConsumption: v.totalConsumption ?? null,
    // Upstream only fills co2TtwEmissions for EU-MRV voyages; for the rest it's 0.
    // Derive it from the fuel burn so non-EU routes don't compare as 0-vs-0.
    co2TtwEmissions: v.co2TtwEmissions && v.co2TtwEmissions > 0 ? v.co2TtwEmissions : round2(co2FromFuel(v)),
    euas: v.euas ?? null,
    liveCost: v.liveCost ?? null,
  }));
}

// --- shared helpers ---------------------------------------------------------

type CiiGrade = "A" | "B" | "C" | "D" | "E";
const GRADE_SET = new Set<string>(["A", "B", "C", "D", "E"]);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A–E grade or undefined (for `.optional()` fields, which reject null). */
function gradeOrUndef(rating: string | null): CiiGrade | undefined {
  const up = (rating ?? "").trim().toUpperCase();
  return GRADE_SET.has(up) ? (up as CiiGrade) : undefined;
}
/** A–E grade or null (for `.nullish()` fields). */
function gradeOrNull(rating: string | null): CiiGrade | null {
  return gradeOrUndef(rating) ?? null;
}
/** kg fuel per nautical mile, or null when distance/consumption are missing. */
function fuelPerNm(r: VoyageRecord): number | null {
  const d = r.totalDistance ?? 0;
  return d > 0 && r.totalConsumption != null ? round2((r.totalConsumption * 1000) / d) : null;
}
/** kg CO2 per nautical mile, or null when distance/emissions are missing. */
function emissionsPerNm(r: VoyageRecord): number | null {
  const d = r.totalDistance ?? 0;
  return d > 0 && r.co2TtwEmissions != null ? round2((r.co2TtwEmissions * 1000) / d) : null;
}

// --- get_voyage_overview (data list — no single widget) ---------------------

const voyageOverviewSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  count: z.number().int(),
  voyages: z.array(
    z.object({
      vesselName: z.string(),
      imo: z.number(),
      segment: z.string().nullable(),
      voyageId: z.string().nullable(),
      departurePort: z.string().nullable(),
      departureDate: z.string().nullable(),
      arrivalPort: z.string().nullable(),
      arrivalDate: z.string().nullable(),
      isCompleted: z.boolean(),
      attainedRating: z.string().nullable(),
      requiredRating: z.string().nullable(),
      totalDistance: z.number().nullable(),
      totalConsumption: z.number().nullable(),
      co2TtwEmissions: z.number().nullable(),
    }),
  ),
});
export type VoyageOverviewData = z.infer<typeof voyageOverviewSchema>;
export const voyageOverviewOutputSchema = voyageOverviewSchema;

/** The raw voyage list (most-recent first). The agent reshapes this into the
 * voyage-cii-rating / vessel-voyages widgets as needed. */
export function projectVoyageOverview(records: VoyageRecord[], args: { startDate: string; endDate: string }): VoyageOverviewData {
  return voyageOverviewSchema.parse({
    startDate: args.startDate,
    endDate: args.endDate,
    count: records.length,
    voyages: records.map((r) => ({
      vesselName: r.vesselName,
      imo: r.imo,
      segment: r.segment,
      voyageId: r.voyageId,
      departurePort: r.departurePort,
      departureDate: r.departureDate,
      arrivalPort: r.arrivalPort,
      arrivalDate: r.arrivalDate,
      isCompleted: r.isCompleted,
      attainedRating: gradeOrNull(r.attainedRating),
      requiredRating: gradeOrNull(r.requiredRating),
      totalDistance: r.totalDistance,
      totalConsumption: r.totalConsumption,
      co2TtwEmissions: r.co2TtwEmissions,
    })),
  });
}

// --- rank_voyages_by_carbon_cost --------------------------------------------

type VoyageCarbonCostData = (typeof voyageCarbonCostDataSchema)["_zod"]["output"];

/** Rank voyages by EU ETS cost (highest first), rank 1..n. */
export function projectVoyageCarbonCost(records: VoyageRecord[]): VoyageCarbonCostData {
  const voyages = records
    .filter((r) => (r.liveCost ?? 0) > 0)
    .map((r) => ({
      vesselName: r.vesselName,
      departurePort: r.departurePort ?? undefined,
      arrivalPort: r.arrivalPort ?? undefined,
      departureDate: r.departureDate ?? undefined,
      liveCost: round2(r.liveCost as number),
      euas: r.euas != null ? round2(r.euas) : undefined,
      co2TtwEmissions: r.co2TtwEmissions != null ? round2(r.co2TtwEmissions) : undefined,
      attainedRating: gradeOrUndef(r.attainedRating),
    }))
    .sort((a, b) => b.liveCost - a.liveCost)
    .map((v, i) => ({ rank: i + 1, ...v }));

  return voyageCarbonCostDataSchema.parse({
    title: "Voyage Carbon Cost",
    currency: "EUR",
    totalCost: round2(voyages.reduce((s, v) => s + v.liveCost, 0)),
    voyages,
  });
}

// --- get_incomplete_voyages -------------------------------------------------

type IncompleteVoyagesData = (typeof incompleteVoyagesDataSchema)["_zod"]["output"];

const avg = (ns: number[]): number | null => (ns.length ? round2(ns.reduce((s, n) => s + n, 0) / ns.length) : null);

/** Incomplete (in-progress) voyages + how their fuel/nm compares to completed ones. */
export function projectIncompleteVoyages(records: VoyageRecord[]): IncompleteVoyagesData {
  const incomplete = records.filter((r) => !r.isCompleted);
  const complete = records.filter((r) => r.isCompleted);

  const incFpn = incomplete.map(fuelPerNm).filter((n): n is number => n != null);
  const compFpn = complete.map(fuelPerNm).filter((n): n is number => n != null);
  const incompleteAvg = avg(incFpn);
  const completeAvg = avg(compFpn);
  const fuelDeltaPct =
    incompleteAvg != null && completeAvg != null && completeAvg > 0
      ? round2(((incompleteAvg - completeAvg) / completeAvg) * 100)
      : null;

  const voyages = incomplete.map((r) => ({
    vesselName: r.vesselName,
    departurePort: r.departurePort,
    arrivalPort: r.arrivalPort,
    departureDate: r.departureDate,
    distance: r.totalDistance,
    fuelPerNm: fuelPerNm(r),
    attainedRating: gradeOrNull(r.attainedRating),
    isShort: (r.totalDistance ?? 0) > 0 && (r.totalDistance as number) < 300,
  }));

  return incompleteVoyagesDataSchema.parse({
    title: "Incomplete Voyages",
    unit: "kg fuel per nautical mile",
    totalVoyages: records.length,
    incompleteCount: incomplete.length,
    completionRatePct: records.length ? round2((complete.length / records.length) * 100) : 0,
    incompleteAvgFuelPerNm: incompleteAvg,
    completeAvgFuelPerNm: completeAvg,
    fuelDeltaPct,
    voyages,
  });
}

// --- shared route grouping --------------------------------------------------

/** Direction-agnostic route key, e.g. "ROTTERDAM <-> SINGAPORE". */
function routeKey(dep: string, arr: string): string {
  return [dep.toUpperCase(), arr.toUpperCase()].sort().join(" <-> ");
}

// --- list_fleet_routes (data list — no single widget) -----------------------

const routeListSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  count: z.number().int(),
  routes: z.array(
    z.object({
      route: z.string(),
      voyageCount: z.number().int(),
      vesselCount: z.number().int(),
      avgEmissionsPerNm: z.number().nullable(),
      comparable: z.boolean(),
    }),
  ),
});
export type RouteListData = z.infer<typeof routeListSchema>;
export const routeListOutputSchema = routeListSchema;

/**
 * List every route the fleet has sailed (direction-agnostic origin↔destination)
 * with its voyage count, distinct vessels, average per-nm CO2, and whether it's
 * `comparable` (>= `minVoyages` voyages that carry a usable per-nm figure). The
 * agent shows these and asks which route to compare before calling
 * compare_emissions_by_route. Sorted by voyage count (busiest first).
 */
export function projectFleetRoutes(
  records: VoyageRecord[],
  args: { startDate: string; endDate: string; minVoyages?: number },
): RouteListData {
  const minVoyages = args.minVoyages ?? 2;

  const groups = new Map<string, { count: number; epns: number[]; vessels: Set<string> }>();
  for (const r of records) {
    if (!r.departurePort || !r.arrivalPort) continue;
    const key = routeKey(r.departurePort, r.arrivalPort);
    const g = groups.get(key) ?? { count: 0, epns: [], vessels: new Set<string>() };
    g.count += 1;
    g.vessels.add(r.vesselName);
    const epn = emissionsPerNm(r);
    if (epn != null) g.epns.push(epn);
    groups.set(key, g);
  }

  const routes = [...groups.entries()]
    .map(([route, g]) => ({
      route,
      voyageCount: g.count,
      vesselCount: g.vessels.size,
      avgEmissionsPerNm: avg(g.epns),
      // Comparison needs >= minVoyages voyages that actually have a per-nm figure.
      comparable: g.epns.length >= minVoyages,
    }))
    .sort((a, b) => b.voyageCount - a.voyageCount);

  return routeListSchema.parse({
    startDate: args.startDate,
    endDate: args.endDate,
    count: routes.length,
    routes,
  });
}

// --- compare_emissions_by_route ---------------------------------------------

type FleetRouteEmissionsData = (typeof fleetRouteEmissionsDataSchema)["_zod"]["output"];

/**
 * Compare per-nm emissions across vessels on a single shared route. Picks the
 * requested `route` (substring match) or, by default, the busiest qualifying
 * route (>= `minVoyages` voyages, default 2).
 */
export function projectRouteComparison(
  records: VoyageRecord[],
  args: { route?: string; minVoyages?: number } = {},
): FleetRouteEmissionsData {
  const minVoyages = args.minVoyages ?? 2;

  // Group voyages (with a usable per-nm figure) by direction-agnostic route.
  const groups = new Map<string, { rec: VoyageRecord; epn: number }[]>();
  for (const r of records) {
    if (!r.departurePort || !r.arrivalPort) continue;
    const epn = emissionsPerNm(r);
    if (epn == null) continue;
    const key = routeKey(r.departurePort, r.arrivalPort);
    const entry = groups.get(key) ?? [];
    entry.push({ rec: r, epn });
    groups.set(key, entry);
  }

  const qualifying = [...groups.entries()].filter(([, vs]) => vs.length >= minVoyages);
  const wanted = args.route?.trim().toLowerCase();
  const chosen =
    (wanted ? qualifying.find(([key]) => key.toLowerCase().includes(wanted)) : undefined) ??
    qualifying.sort((a, b) => b[1].length - a[1].length)[0];

  if (!chosen) {
    return fleetRouteEmissionsDataSchema.parse({
      title: "Route Emissions Comparison",
      route: wanted ? `No voyages found for "${args.route}"` : "No shared route with enough voyages",
      unit: "kg CO2 (tank-to-wake) per nautical mile",
      voyages: [],
    });
  }

  const [key, vs] = chosen;
  const sorted = [...vs].sort((a, b) => a.epn - b.epn);
  const epns = sorted.map((v) => v.epn);
  const avgEpn = avg(epns) ?? 0;
  const minEpn = epns[0];
  const maxEpn = epns[epns.length - 1];

  return fleetRouteEmissionsDataSchema.parse({
    title: "Route Emissions Comparison",
    route: key,
    unit: "kg CO2 (tank-to-wake) per nautical mile",
    avgEmissionsPerNm: avgEpn,
    spreadPct: avgEpn > 0 ? round2(((maxEpn - minEpn) / avgEpn) * 100) : 0,
    bestVessel: sorted[0]?.rec.vesselName,
    worstVessel: sorted[sorted.length - 1]?.rec.vesselName,
    voyages: sorted.map(({ rec, epn }) => ({
      vesselName: rec.vesselName,
      departurePort: rec.departurePort ?? undefined,
      arrivalPort: rec.arrivalPort ?? undefined,
      departureDate: rec.departureDate ?? undefined,
      emissionsPerNm: epn,
      totalDistance: rec.totalDistance ?? undefined,
    })),
  });
}
