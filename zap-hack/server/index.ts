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
import { gatherCiiFacts } from "./vessel-facts.js";
import { loadFixture } from "./westship.js";

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

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Westship adapter tool server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`  OpenAPI: http://localhost:${PORT}/openapi.json`);
});
