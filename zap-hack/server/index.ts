/**
 * Westship adapter tool server.
 *
 * Serves its own OpenAPI spec at GET /openapi.json and the data operation at
 * POST /get_emission_analytics. `zap serve` discovers the operation as the agent
 * tool `westship_get_emission_analytics` (domainId `westship` + operationId).
 */
import express from "express";

import { buildOpenApiSpec } from "./openapi.js";
import { projectEmissionAnalytics } from "./projections/emission-analytics.js";
import { fetchCii } from "./westship.js";

const PORT = Number(process.env.PORT ?? 9001);

const app = express();
app.use(express.json({ limit: "5mb" }));

// OpenAPI spec — ZAP reads this once at startup to register tools.
app.get("/openapi.json", (_req, res) => {
  res.json(buildOpenApiSpec());
});

// Data tool: raw Westship -> emission_analytics widget shape.
app.post("/get_emission_analytics", async (req, res) => {
  const { vesselId, year, vesselName } = req.body ?? {};
  if (vesselId === undefined || year === undefined) {
    res.status(400).json({ error: "vesselId and year are required" });
    return;
  }
  try {
    // The platform forwards the caller's Authorization header; pass it through to Westship.
    const raw = await fetchCii({ vesselId, year: Number(year), auth: req.headers.authorization });
    const data = projectEmissionAnalytics(raw, { vesselName, year: Number(year) });
    res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: message });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Westship adapter tool server listening on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`  OpenAPI: http://localhost:${PORT}/openapi.json`);
});
