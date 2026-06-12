/**
 * Projections for the /vessel-cii fleet tools — raw emission-analytics JSON ->
 * the widgets' own Zod-validated shapes.
 *
 * One upstream feed (`/vessel-cii`, fetched soft in westship.ts) backs five
 * tools: CII ratings, emissions overview, compliance risk, EU ETS cost, and
 * emissions-per-nm rank. `extractVesselCiiRecords` normalises the raw paged
 * payload into clean per-vessel records once; each `project*` then shapes a
 * record set into a specific widget's data and `.parse()`s it against that
 * widget's schema (imported from zap-widgets — a hard lockstep guard).
 */
import {
  fleetCiiRatingDataSchema,
  fleetComplianceRiskDataSchema,
  fleetEmissionsOverviewDataSchema,
  fleetEmissionsRankDataSchema,
  fleetEtsCostDataSchema,
} from "../../../../zap-widgets/src/emission/schema/index.js";

import type { RawJson } from "../westship.js";

// --- raw -> clean per-vessel record -----------------------------------------

/** A normalised per-vessel CII record (only the fields the tools use). */
export type VesselCiiRecord = {
  imo: number;
  name: string;
  segment: string | null;
  rating: string | null;
  requiredRating: string | null;
  co2TtwEmissions: number | null;
  distanceSailed: number | null;
  totalConsumption: number | null;
  voyageCount: number | null;
  fuelEuComplianceBal: number | null;
  fuelEuPenaltyCost: number | null;
  euas: number | null;
  liveCost: number | null;
  minimumEeoiDelta: number | null;
};

/** The fields we read off each raw `/vessel-cii` item (partial — only what we use). */
type VesselCiiApiItem = {
  imo?: number;
  vesselName?: string;
  segment?: string | null;
  rating?: string | null;
  requiredCii?: { rating?: string | null } | null;
  co2TtwEmissions?: number | null;
  distanceSailed?: number | null;
  totalConsumption?: number | null;
  voyageCount?: number | null;
  fuelEuComplianceBal?: number | null;
  fuelEuPenaltyCost?: number | null;
  euas?: number | null;
  liveCost?: number | null;
  minimumEeoiAlignmentDelta?: number | null;
};

/** Pull the clean per-vessel records out of a raw `/vessel-cii` response (`{ data: [...] }`). */
export function extractVesselCiiRecords(raw: RawJson): VesselCiiRecord[] {
  const data = (raw?.["data"] as VesselCiiApiItem[] | undefined) ?? [];
  return data.map((v) => ({
    imo: Number(v.imo ?? 0),
    name: v.vesselName ?? "",
    segment: v.segment ?? null,
    rating: v.rating ?? null,
    requiredRating: v.requiredCii?.rating ?? null,
    co2TtwEmissions: v.co2TtwEmissions ?? null,
    distanceSailed: v.distanceSailed ?? null,
    totalConsumption: v.totalConsumption ?? null,
    voyageCount: v.voyageCount ?? null,
    fuelEuComplianceBal: v.fuelEuComplianceBal ?? null,
    fuelEuPenaltyCost: v.fuelEuPenaltyCost ?? null,
    euas: v.euas ?? null,
    liveCost: v.liveCost ?? null,
    minimumEeoiDelta: v.minimumEeoiAlignmentDelta ?? null,
  }));
}

// --- shared grade helpers ---------------------------------------------------

type CiiGrade = "A" | "B" | "C" | "D" | "E";
const GRADES: CiiGrade[] = ["A", "B", "C", "D", "E"];
const GRADE_SET = new Set<string>(GRADES);
// Severity order for comparing attained vs required grade (higher = worse).
const GRADE_ORDER: Record<CiiGrade, number> = { A: 0, B: 1, C: 2, D: 3, E: 4 };

/** Normalise a raw rating to an A–E grade, or null if outside the band. */
function toGrade(rating: string | null): CiiGrade | null {
  const up = (rating ?? "").trim().toUpperCase();
  return GRADE_SET.has(up) ? (up as CiiGrade) : null;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

// --- get_fleet_cii_ratings --------------------------------------------------

type FleetCiiRatingData = (typeof fleetCiiRatingDataSchema)["_zod"]["output"];

/**
 * Project vessel-cii records into the fleet-cii-rating widget shape: the per-grade
 * distribution (`ratings`) plus the individual vessels with their attained grade.
 * Vessels outside A–E (null / "N/A") are ignored — the widget only shows A–E.
 */
export function projectFleetCiiRatings(records: VesselCiiRecord[], args: { year: number }): FleetCiiRatingData {
  const counts: Record<CiiGrade, number> = { A: 0, B: 0, C: 0, D: 0, E: 0 };
  const vessels: { name: string; grade: CiiGrade }[] = [];
  for (const r of records) {
    const grade = toGrade(r.rating);
    if (grade) {
      counts[grade] += 1;
      vessels.push({ name: r.name, grade });
    }
  }

  return fleetCiiRatingDataSchema.parse({
    title: "Fleet CII Rating",
    year: args.year,
    total: records.length,
    ratings: GRADES.filter((g) => counts[g] > 0).map((grade) => ({ grade, count: counts[grade] })),
    vessels,
  });
}

// --- get_fleet_emissions_overview -------------------------------------------

type FleetEmissionsOverviewData = (typeof fleetEmissionsOverviewDataSchema)["_zod"]["output"];

/**
 * Fleet totals + per-vessel breakdown (highest CO2 first). Only EU-scope vessels
 * (co2 > 0 and distance > 0) contribute — others show no emissions and are dropped.
 */
export function projectFleetEmissionsOverview(
  records: VesselCiiRecord[],
  args: { year: number },
): FleetEmissionsOverviewData {
  const active = records.filter((r) => (r.co2TtwEmissions ?? 0) > 0 && (r.distanceSailed ?? 0) > 0);

  const vessels = active
    .map((r) => {
      const co2 = r.co2TtwEmissions as number;
      const distance = r.distanceSailed as number;
      return {
        name: r.name,
        grade: toGrade(r.rating),
        co2TtwEmissions: round2(co2),
        distanceSailed: round2(distance),
        emissionsPerNm: round2((co2 * 1000) / distance),
        voyageCount: r.voyageCount,
      };
    })
    .sort((a, b) => b.co2TtwEmissions - a.co2TtwEmissions);

  const totalCo2 = active.reduce((s, r) => s + (r.co2TtwEmissions as number), 0);
  const totalDistance = active.reduce((s, r) => s + (r.distanceSailed as number), 0);
  const totalConsumption = active.reduce((s, r) => s + (r.totalConsumption ?? 0), 0);

  return fleetEmissionsOverviewDataSchema.parse({
    title: "Fleet Emissions Overview",
    year: args.year,
    unit: "kg CO2 (tank-to-wake) per nautical mile",
    totalCo2: round2(totalCo2),
    totalDistance: round2(totalDistance),
    totalConsumption: round2(totalConsumption),
    avgEmissionsPerNm: totalDistance > 0 ? round2((totalCo2 * 1000) / totalDistance) : 0,
    vessels,
  });
}

// --- get_fleet_compliance_risk ----------------------------------------------

type FleetComplianceRiskData = (typeof fleetComplianceRiskDataSchema)["_zod"]["output"];

/**
 * Composite multi-regime risk per vessel: CII (D/E or worse-than-required), FuelEU
 * (negative balance → penalty), EU ETS (cost exposure), EEOI (above min trajectory).
 * Risk = breach count + € at stake; classified High/Medium/Low, highest risk first.
 */
export function projectFleetComplianceRisk(
  records: VesselCiiRecord[],
  args: { year: number },
): FleetComplianceRiskData {
  const isActive = (r: VesselCiiRecord): boolean => (r.co2TtwEmissions ?? 0) > 0 || (r.liveCost ?? 0) > 0;
  const active = records.filter(isActive);
  const excludedCount = records.length - active.length;

  const vessels = active
    .map((r) => {
      const ciiGrade = toGrade(r.rating);
      const ciiReq = toGrade(r.requiredRating);
      const worseThanRequired = ciiGrade != null && ciiReq != null && GRADE_ORDER[ciiGrade] > GRADE_ORDER[ciiReq];
      const ciiBreach = ciiGrade === "D" || ciiGrade === "E" || worseThanRequired;

      const fuelEuBreach = (r.fuelEuComplianceBal ?? 0) < 0;
      const penalty = fuelEuBreach ? Math.max(0, r.fuelEuPenaltyCost ?? 0) : 0;
      const eeoiBreach = (r.minimumEeoiDelta ?? 0) > 0;
      const etsCost = r.liveCost ?? 0;

      const breaches = [ciiBreach, fuelEuBreach, eeoiBreach].filter(Boolean).length;
      const moneyAtRisk = penalty + etsCost;
      const level = breaches >= 2 || moneyAtRisk > 300_000 ? "High" : breaches === 1 || moneyAtRisk > 100_000 ? "Medium" : "Low";

      const reasons: string[] = [];
      if (ciiBreach) {
        reasons.push(ciiReq != null ? `CII ${ciiGrade ?? "?"} — worse than required ${ciiReq}` : `CII rated ${ciiGrade ?? "?"}`);
      }
      if (fuelEuBreach) {
        reasons.push(`FuelEU deficit (${round2(r.fuelEuComplianceBal ?? 0)}) → €${Math.round(penalty).toLocaleString()} penalty`);
      }
      if (eeoiBreach) reasons.push(`EEOI ${round2(r.minimumEeoiDelta ?? 0)}% above minimum trajectory`);
      if (etsCost > 0) reasons.push(`EU ETS cost €${Math.round(etsCost).toLocaleString()}`);

      return {
        name: r.name,
        segment: r.segment,
        level,
        breaches,
        moneyAtRisk: round2(moneyAtRisk),
        ciiRating: ciiGrade,
        requiredRating: ciiReq,
        ciiBreach,
        fuelEuBalance: r.fuelEuComplianceBal != null ? round2(r.fuelEuComplianceBal) : null,
        fuelEuPenaltyCost: fuelEuBreach ? round2(penalty) : null,
        fuelEuBreach,
        etsCost: r.liveCost != null ? round2(r.liveCost) : null,
        euas: r.euas != null ? round2(r.euas) : null,
        eeoiDeltaPct: r.minimumEeoiDelta != null ? round2(r.minimumEeoiDelta) : null,
        eeoiBreach,
        reasons,
      };
    })
    .sort((a, b) => b.breaches - a.breaches || b.moneyAtRisk - a.moneyAtRisk);

  return fleetComplianceRiskDataSchema.parse({
    title: "Fleet Compliance Risk",
    year: args.year,
    currency: "EUR",
    vesselCount: vessels.length,
    atRiskCount: vessels.filter((v) => v.breaches > 0).length,
    excludedCount,
    totalMoneyAtRisk: round2(vessels.reduce((s, v) => s + v.moneyAtRisk, 0)),
    totalEuas: round2(active.reduce((s, r) => s + (r.euas ?? 0), 0)),
    vessels,
  });
}

// --- get_fleet_ets_cost -----------------------------------------------------

type FleetEtsCostData = (typeof fleetEtsCostDataSchema)["_zod"]["output"];

/** Fleet total EU ETS cost + allowances, with a per-vessel breakdown (highest cost first). */
export function projectFleetEtsCost(records: VesselCiiRecord[], args: { year: number }): FleetEtsCostData {
  const withCost = records.filter((r) => (r.liveCost ?? 0) > 0 || (r.euas ?? 0) > 0);

  const vessels = withCost
    .map((r) => ({
      name: r.name,
      segment: r.segment,
      grade: toGrade(r.rating),
      etsCost: round2(r.liveCost ?? 0),
      euas: round2(r.euas ?? 0),
    }))
    .sort((a, b) => b.etsCost - a.etsCost);

  return fleetEtsCostDataSchema.parse({
    title: "Fleet EU ETS Cost",
    year: args.year,
    currency: "EUR",
    totalCost: round2(withCost.reduce((s, r) => s + (r.liveCost ?? 0), 0)),
    totalEuas: round2(withCost.reduce((s, r) => s + (r.euas ?? 0), 0)),
    vesselCount: vessels.length,
    vessels,
  });
}

// --- rank_vessels_by_emissions_per_nm ---------------------------------------

type FleetEmissionsRankData = (typeof fleetEmissionsRankDataSchema)["_zod"]["output"];

/** Rank vessels by tank-to-wake kg CO2 per nautical mile (worst first), rank 1..n. */
export function projectFleetEmissionsRank(records: VesselCiiRecord[], args: { year: number }): FleetEmissionsRankData {
  const vessels = records
    .filter((r) => (r.co2TtwEmissions ?? 0) > 0 && (r.distanceSailed ?? 0) > 0)
    .map((r) => ({
      name: r.name,
      emissionsPerNm: round2(((r.co2TtwEmissions as number) * 1000) / (r.distanceSailed as number)),
      // Carry the raw figures too so the vessel-detail and compare widgets the agent
      // builds from this result can fill their Distance / Total CO2 rows.
      distanceSailed: round2(r.distanceSailed as number),
      totalEmissions: round2(r.co2TtwEmissions as number),
    }))
    .sort((a, b) => b.emissionsPerNm - a.emissionsPerNm)
    .map((v, i) => ({ rank: i + 1, ...v }));

  return fleetEmissionsRankDataSchema.parse({
    title: "Emissions per Nautical Mile",
    year: args.year,
    unit: "kg CO2 (tank-to-wake) per nautical mile",
    vessels,
  });
}
