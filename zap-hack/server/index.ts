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
import { gatherCiiFacts, gatherVesselDetailsFacts } from "./vessel-facts.js";
import { loadFixture, type FixtureName, type RawJson } from "./westship.js";

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

// Data tool: live emission-analytics (or demo fixture) -> emission_analytics widget shape.
app.post("/get_emission_analytics", async (req, res) => {
  const { vesselId, year, vesselName } = req.body ?? {};
  if (vesselId === undefined || year === undefined) {
    res.status(400).json({ error: "vesselId and year are required" });
    return;
  }

  // Always-200: upstream failures are data (dataSource:"fixture"), not exceptions.
  try {
    const facts = await gatherCiiFacts({ vesselId, year: Number(year), auth: authOf(req) });
    const data = projectEmissionAnalytics(facts.raw, { vesselName, year: Number(year) });
    res.json({ ...data, dataSource: facts.dataSource, ...(facts.message ? { message: facts.message } : {}) });
  } catch (err) {
    // Even a projection error shouldn't 5xx — fall back to the fixture shape.
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
