/**
 * Westship adapter tool server.
 *
 * Serves its own OpenAPI spec at GET /openapi.json and the data operation at
 * POST /get_emission_analytics. `zap serve` discovers the operation as the agent
 * tool `westship_get_emission_analytics` (domainId `westship` + operationId).
 *
 * The handler is ALWAYS-200: upstream failures (no token / 403 RBAC / unreachable)
 * are returned as data (`dataSource:"fixture"` + a `message`), never as a 5xx. The
 * live-vs-fixture decision lives entirely in ./vessel-facts.ts.
 */
import express from "express";

import { buildOpenApiSpec } from "./openapi.js";
import { projectEmissionAnalytics } from "./projections/emission-analytics.js";
import { projectEuEts } from "./projections/eu-ets.js";
import { projectFleetSummary } from "./projections/fleet-summary.js";
import { projectFuelConsumption } from "./projections/fuel-consumption.js";
import {
  extractVesselCiiRecords,
  projectFleetCiiRatings,
  projectFleetComplianceRisk,
  projectFleetEmissionsOverview,
  projectFleetEmissionsRank,
  projectFleetEtsCost,
  type VesselCiiRecord,
} from "./projections/vessel-cii.js";
import {
  extractVoyageRecords,
  projectFleetRoutes,
  projectIncompleteVoyages,
  projectRouteComparison,
  projectVoyageCarbonCost,
  projectVoyageOverview,
  type VoyageRecord,
} from "./projections/voyages.js";
import {
  buildConsumptionRequest,
  extractForecastVessels,
  findForecastVessel,
  projectCiiRatingDistribution,
  projectVesselCiiForecast,
} from "./projections/cii-charts.js";
import { gatherCiiFacts, gatherVesselDetailsFacts } from "./vessel-facts.js";
import {
  evaluateConsumption,
  fetchVesselCii,
  fetchVesselParticulars,
  fetchVoyageOverview,
  loadFixture,
  type FixtureName,
  type RawJson,
} from "./westship.js";

const PORT = Number(process.env.PORT ?? 9001);

const app = express();
app.use(express.json({ limit: "5mb" }));

/** Pull the operator bearer token off the inbound request (forwarded by the platform). */
function authOf(req: express.Request): string | undefined {
  const h = req.headers.authorization;
  return typeof h === "string" && h.length > 0 ? h : undefined;
}

// OpenAPI spec — ZAP reads this once at startup to register tools.
app.get("/openapi.json", (_req, res) => {
  res.json(buildOpenApiSpec());
});

/**
 * Vessel CII analytics (emission_analytics widget). Soft-fetch the year-to-date CII
 * graph for one vessel, project it into the widget shape; on no-token / 403 / error
 * fall back to the demo fixture. Always-200.
 */
app.post("/get_emission_analytics", async (req, res) => {
  const { vesselId, year, vesselName } = req.body ?? {};
  if (vesselId === undefined || year === undefined) {
    res.status(400).json({ error: "vesselId and year are required" });
    return;
  }
  try {
    const facts = await gatherCiiFacts({ vesselId, year: Number(year), auth: authOf(req) });
    const data = projectEmissionAnalytics(facts.raw, { vesselName, year: Number(year) });
    res.json({ ...data, dataSource: facts.dataSource, ...(facts.message ? { message: facts.message } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      const data = projectEmissionAnalytics(loadFixture(), { vesselName, year: Number(year) });
      res.json({ ...data, dataSource: "fixture", message: `Projection error (${message}) — showing demo fixture.` });
    } catch {
      res.status(200).json({ dataAvailable: false, message });
    }
  }
});

/**
 * Register a vessel-cii–backed tool: soft-fetch /vessel-cii once, then project the
 * records into the given widget shape. Always-200 — on no-token / 403 / failure we
 * get no rows and the projection returns a valid empty-fleet payload.
 */
function vesselCiiTool(
  path: string,
  project: (records: VesselCiiRecord[], args: { year: number }) => Record<string, unknown>,
): void {
  app.post(path, async (req, res) => {
    const year = Number(req.body?.year ?? new Date().getUTCFullYear());
    const result = await fetchVesselCii({ year, auth: authOf(req) });
    const records = result.ok && result.data ? extractVesselCiiRecords(result.data) : [];
    const dataSource = records.length > 0 ? "live" : "empty";
    res.json({ ...project(records, { year }), dataSource });
  });
}

vesselCiiTool("/get_fleet_cii_ratings", projectFleetCiiRatings);
vesselCiiTool("/get_fleet_emissions_overview", projectFleetEmissionsOverview);
vesselCiiTool("/get_fleet_compliance_risk", projectFleetComplianceRisk);
vesselCiiTool("/get_fleet_ets_cost", projectFleetEtsCost);
vesselCiiTool("/rank_vessels_by_emissions_per_nm", projectFleetEmissionsRank);
vesselCiiTool("/get_cii_rating_distribution", projectCiiRatingDistribution);

/**
 * Single-vessel CII forecast (cii_forecast_chart widget). Identify the vessel by
 * imo or vesselName. Two soft fetches cover the 2023→2030 span: the current-year
 * snapshot (previous year + current + futures) and the snapshot two years back
 * (extends the historical tail). Then — if the vessel resolves — the vessel's
 * draught (particulars) + a consumption sweep build the per-speed CII curve.
 * Always-200 — a miss yields an empty forecast; a particulars/consumption miss
 * just drops the speed curve (widget falls back to boundary bands).
 */
app.post("/get_vessel_cii_forecast", async (req, res) => {
  const imo = req.body?.imo != null ? Number(req.body.imo) : undefined;
  const vesselName = typeof req.body?.vesselName === "string" ? (req.body.vesselName as string) : undefined;
  const auth = authOf(req);
  const currentYear = new Date().getUTCFullYear();

  const [cur, older] = await Promise.all([
    fetchVesselCii({ year: currentYear, auth }),
    fetchVesselCii({ year: currentYear - 2, auth }),
  ]);
  const current = cur.ok && cur.data ? extractForecastVessels(cur.data) : [];
  const olderVessels = older.ok && older.data ? extractForecastVessels(older.data) : [];

  // Resolve the vessel up front to drive the speed-curve calls (draught + consumption).
  const vessel = findForecastVessel(current, { imo, vesselName });
  let consumptions: { speed: number; consumption: number }[] = [];
  if (vessel) {
    const particulars = await fetchVesselParticulars({ imo: vessel.imo, auth });
    const maxDraught =
      particulars.ok && particulars.data ? Number((particulars.data as { max_draught?: number }).max_draught ?? 0) : 0;

    const request = buildConsumptionRequest(vessel.imo, maxDraught || null);
    const evalRes = await evaluateConsumption({ body: request, auth });
    const rows = evalRes.ok && evalRes.data ? ((evalRes.data as { consumptions?: { consumption?: number }[] }).consumptions ?? []) : [];
    consumptions = rows
      .map((c, i) => ({ speed: request.evaluations[i]?.speed_over_ground ?? -1, consumption: Number(c?.consumption ?? 0) }))
      .filter((c) => c.speed > 0);
  }

  const data = projectVesselCiiForecast(current, olderVessels, { imo, vesselName, consumptions });
  res.json({ ...data, dataSource: data.years.length > 0 ? "live" : "empty" });
});

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/** Soft-fetch the fleet's voyages for the requested range (defaults: last 12 months). */
async function gatherVoyages(req: express.Request): Promise<{ records: VoyageRecord[]; startDate: string; endDate: string }> {
  const end = (req.body?.endDate as string | undefined) ?? new Date().toISOString();
  const start = (req.body?.startDate as string | undefined) ?? new Date(new Date(end).getTime() - YEAR_MS).toISOString();
  const search = req.body?.search as string | undefined;
  const result = await fetchVoyageOverview({ startDate: start, endDate: end, search, auth: authOf(req) });
  const records = result.ok && result.data ? extractVoyageRecords(result.data) : [];
  return { records, startDate: start, endDate: end };
}

const voyageSource = (records: VoyageRecord[]): "live" | "empty" => (records.length > 0 ? "live" : "empty");

app.post("/get_voyage_overview", async (req, res) => {
  const { records, startDate, endDate } = await gatherVoyages(req);
  res.json({ ...projectVoyageOverview(records, { startDate, endDate }), dataSource: voyageSource(records) });
});

app.post("/rank_voyages_by_carbon_cost", async (req, res) => {
  const { records } = await gatherVoyages(req);
  res.json({ ...projectVoyageCarbonCost(records), dataSource: voyageSource(records) });
});

app.post("/get_incomplete_voyages", async (req, res) => {
  const { records } = await gatherVoyages(req);
  res.json({ ...projectIncompleteVoyages(records), dataSource: voyageSource(records) });
});

app.post("/list_fleet_routes", async (req, res) => {
  const { records, startDate, endDate } = await gatherVoyages(req);
  const minVoyages = req.body?.minVoyages as number | undefined;
  res.json({ ...projectFleetRoutes(records, { startDate, endDate, minVoyages }), dataSource: voyageSource(records) });
});

app.post("/compare_emissions_by_route", async (req, res) => {
  const { records } = await gatherVoyages(req);
  const route = req.body?.route as string | undefined;
  const minVoyages = req.body?.minVoyages as number | undefined;
  res.json({ ...projectRouteComparison(records, { route, minVoyages }), dataSource: voyageSource(records) });
});

/**
 * Register a vessel-details-backed widget tool. All three share one upstream call
 * (`/vessel-details/<imo>`) and the always-200 contract; they differ only in which
 * fixture they fall back to and which projection they run.
 */
function registerVesselDetailsTool(
  path: string,
  fixtureName: FixtureName,
  project: (raw: RawJson, args: { vesselName?: string | null; year: number }) => unknown,
): void {
  app.post(path, async (req, res) => {
    const { vesselId, year, vesselName } = req.body ?? {};
    if (vesselId === undefined || year === undefined) {
      res.status(400).json({ error: "vesselId and year are required" });
      return;
    }

    try {
      const fixture = loadFixture(fixtureName);
      const facts = await gatherVesselDetailsFacts({ vesselId, year: Number(year), auth: authOf(req), fixture });
      const data = project(facts.raw, { vesselName, year: Number(year) }) as Record<string, unknown>;
      res.json({ ...data, dataSource: facts.dataSource, ...(facts.message ? { message: facts.message } : {}) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const data = project(loadFixture(fixtureName), { vesselName, year: Number(year) }) as Record<string, unknown>;
        res.json({ ...data, dataSource: "fixture", message: `Projection error (${message}) — showing demo fixture.` });
      } catch {
        res.status(200).json({ dataAvailable: false, message });
      }
    }
  });
}

registerVesselDetailsTool("/get_eu_ets", "eu-ets", projectEuEts);
registerVesselDetailsTool("/get_fuel_consumption", "fuel-consumption", projectFuelConsumption);
registerVesselDetailsTool("/get_fleet_summary", "fleet-summary", projectFleetSummary);

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Westship adapter tool server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`  OpenAPI: http://localhost:${PORT}/openapi.json`);
});
