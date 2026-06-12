/**
 * Auto-assembled OpenAPI spec for the Westship adapter tool server.
 *
 * ZAP discovers agent tools only from an OpenAPI spec served by a tool server.
 * We don't write Swagger for upstream Westship — we describe our OWN clean
 * operations here. `x-zap.enabled` opts the spec in; each operation needs a
 * snake_case operationId + summary + description (zap lint enforces this).
 *
 * domainId (`westship`, from zap/domain.yaml) + operationId (`get_emission_analytics`)
 * => the agent sees the tool as `westship_get_emission_analytics`.
 */
import { z } from "zod";

import {
  emissionAnalyticsInputSchema,
  emissionEuEtsInputSchema,
  emissionFleetSummaryInputSchema,
  emissionFuelConsumptionInputSchema,
  ciiForecastDataSchema,
  ciiRatingDistributionDataSchema,
  fleetCiiRatingDataSchema,
  fleetComplianceRiskDataSchema,
  fleetEmissionsOverviewDataSchema,
  fleetEmissionsRankDataSchema,
  fleetEtsCostDataSchema,
  fleetRouteEmissionsDataSchema,
  incompleteVoyagesDataSchema,
  voyageCarbonCostDataSchema,
} from "../../../zap-widgets/src/emission/schema/index.js";
import { routeListOutputSchema, voyageOverviewOutputSchema } from "./projections/voyages.js";

const CII_RATING_DESCRIPTION = "CII rating band: A (best) through E (worst).";

/**
 * Recursively ensure every enum node carries a description.
 *
 * `z.toJSONSchema` is called from zap-hack's zod instance, but the widget schema's
 * `.describe()`/`.meta()` live in zap-widgets' zod global registry — so enum
 * descriptions are dropped on the way out. `zap lint` requires them on agent-enabled
 * operations, so we restore them here. A–E is the CiiRating band; anything else gets
 * a generic note listing the allowed values.
 */
function restoreEnumDescriptions(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(restoreEnumDescriptions);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.enum) && typeof obj.description !== "string") {
    const values = obj.enum as unknown[];
    const isCiiRating = values.length === 5 && values.every((v, i) => v === ["A", "B", "C", "D", "E"][i]);
    obj.description = isCiiRating ? CII_RATING_DESCRIPTION : `One of: ${values.join(", ")}.`;
  }
  for (const value of Object.values(obj)) restoreEnumDescriptions(value);
}

/**
 * Inline every `$ref` into a self-contained schema and drop the `definitions`/`$defs`
 * block. `z.toJSONSchema` extracts `.meta({ id })` sub-schemas (the widgets use ids)
 * into `definitions` + `#/definitions/X` refs. That resolves standalone, but once the
 * schema is embedded per-response in the OpenAPI doc the pointer targets the doc root
 * (no `definitions` there) → `zap lint` invalid-ref and the domain is dropped. The
 * widget schemas are acyclic, so inlining is safe.
 */
function inlineDefs(root: Record<string, unknown>): Record<string, unknown> {
  const defs = (root.definitions ?? root.$defs ?? {}) as Record<string, unknown>;
  const resolve = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(resolve);
    if (node === null || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    const ref = obj.$ref;
    if (typeof ref === "string") {
      const m = ref.match(/^#\/(?:definitions|\$defs)\/(.+)$/);
      if (m && defs[m[1]]) return resolve(defs[m[1]]);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === "definitions" || k === "$defs") continue;
      out[k] = resolve(v);
    }
    return out;
  };
  return resolve(root) as Record<string, unknown>;
}

/**
 * Best-effort JSON Schema for a widget's data; falls back to a loose object on any
 * drift. Appends the two sibling fields the handlers add (observability — widgets
 * ignore unknown keys): `dataSource` (which feed the figures came from) and an
 * optional `message` explaining a fixture/empty fallback.
 */
function widgetResponseSchema(inputSchema: z.ZodType, fallbackDesc: string): Record<string, unknown> {
  try {
    const raw = z.toJSONSchema(inputSchema, { target: "draft-7" }) as Record<string, unknown>;
    const schema = inlineDefs(raw);
    restoreEnumDescriptions(schema);
    if (schema.type === "object") {
      schema.properties = {
        ...(schema.properties as Record<string, unknown> | undefined),
        dataSource: {
          type: "string",
          enum: ["live", "fixture", "empty"],

          description: "Whether the figures are live upstream data, the demo fixture, or empty (no rows).",
        },
        message: {
          type: "string",
          description: "Present when data is a fixture/empty — explains why (e.g. 403 RBAC, no token).",
        },
      };
    }
    return schema;
  } catch {
    return { type: "object", description: fallbackDesc };
  }
}

/** Shared request body for the single-vessel tools: `{ vesselId, year, vesselName? }`. */
function vesselRequestBody(): Record<string, unknown> {
  return {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object",
          required: ["vesselId", "year"],
          properties: {
            vesselId: {
              type: "string",
              description: "Westship vessel identifier (or IMO number) to fetch data for.",
            },
            year: {
              type: "integer",
              description: "Reporting year, e.g. 2026.",
            },
            vesselName: {
              type: "string",
              description: "Optional display name shown in the widget header.",
            },
          },
        },
      },
    },
  };
}

/** Build one POST operation that returns a widget-shaped payload (single-vessel tools). */
function widgetOperation(args: {
  operationId: string;
  summary: string;
  description: string;
  responseDescription: string;
  schema: z.ZodType;
}): Record<string, unknown> {
  return {
    post: {
      operationId: args.operationId,
      summary: args.summary,
      description: args.description,
      requestBody: vesselRequestBody(),
      responses: {
        "200": {
          description: args.responseDescription,
          content: { "application/json": { schema: widgetResponseSchema(args.schema, args.responseDescription) } },
        },
      },
    },
  };
}

/** A standard fleet tool operation: optional `year` body in, widget-data out. */
function fleetToolOp(op: {
  operationId: string;
  summary: string;
  description: string;
  schema: z.ZodType;
  widget: string;
}): Record<string, unknown> {
  return {
    post: {
      operationId: op.operationId,
      summary: op.summary,
      description: op.description,
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                year: { type: "integer", description: "Reporting year. Defaults to the current year." },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: `${op.widget} widget data.`,
          content: {
            "application/json": {
              schema: widgetResponseSchema(op.schema, `${op.widget} widget data (see zap-widgets schema).`),
            },
          },
        },
      },
    },
  };
}

/** All fleet (vessel-cii–backed) tool operations, keyed by path. */
function buildFleetToolPaths(): Record<string, unknown> {
  return {
    "/get_fleet_cii_ratings": fleetToolOp({
      operationId: "get_fleet_cii_ratings",
      summary: "Get the fleet's CII ratings",
      description:
        "Get the fleet's CII (Carbon Intensity Indicator) ratings for a year — the per-grade A–E counts and " +
        "percentages, the count of vessels rated D or E up front, and every vessel with its attained grade. " +
        "This is THE tool for the fleet's rating distribution/breakdown/spread AND for at-risk questions: " +
        "'show me the full CII rating distribution', 'how are my vessels rated across A–E', 'CII rating " +
        "breakdown', 'count by grade', 'how many of my vessels are rated D or E', 'which vessels are at risk'. " +
        "Render with the fleet-cii-rating widget for the full A–E distribution/breakdown, or the " +
        "fleet-cii-at-risk widget for 'how many are rated D or E' / 'which vessels are at risk' (it lists the " +
        "D/E vessels + % of fleet).",
      schema: fleetCiiRatingDataSchema as unknown as z.ZodType,
      widget: "fleet-cii-rating",
    }),
    "/get_fleet_emissions_overview": fleetToolOp({
      operationId: "get_fleet_emissions_overview",
      summary: "Get the fleet emissions overview",
      description:
        "Get a fleet-wide emissions overview for a year — fleet totals (total CO2, distance, fuel, average " +
        "kg CO2/nm) plus a per-vessel breakdown sorted by total tank-to-wake CO2 (highest emitter first), " +
        "each with its CII grade and emissions per nm. Answers 'fleet emissions overview', 'emissions by " +
        "vessel', 'which vessels emit the most'. Pair with the fleet-emissions-overview widget.",
      schema: fleetEmissionsOverviewDataSchema as unknown as z.ZodType,
      widget: "fleet-emissions-overview",
    }),
    "/get_fleet_compliance_risk": fleetToolOp({
      operationId: "get_fleet_compliance_risk",
      summary: "Get the fleet compliance risk",
      description:
        "Assess each vessel's regulatory compliance risk across multiple regimes — CII (D/E or worse than " +
        "required), FuelEU Maritime (negative balance → EUR penalty), EU ETS (allowance cost exposure), and " +
        "EEOI (above the minimum trajectory). Risk = breaches + € at stake; vessels are classified " +
        "High/Medium/Low, highest risk first, each with a 'why flagged' reason list. Answers 'which vessels " +
        "are at compliance risk'. Pair with the fleet-compliance-risk widget.",
      schema: fleetComplianceRiskDataSchema as unknown as z.ZodType,
      widget: "fleet-compliance-risk",
    }),
    "/get_fleet_ets_cost": fleetToolOp({
      operationId: "get_fleet_ets_cost",
      summary: "Get the fleet EU ETS cost",
      description:
        "Get the fleet's total EU ETS cost for a year — fleet total € + allowances to surrender, plus a " +
        "per-vessel breakdown sorted by cost (highest first). Answers 'what's the total EU ETS cost for the " +
        "fleet', 'EU ETS cost by vessel', 'how many allowances must we surrender'. Pair with the " +
        "fleet-ets-cost widget.",
      schema: fleetEtsCostDataSchema as unknown as z.ZodType,
      widget: "fleet-ets-cost",
    }),
    "/rank_vessels_by_emissions_per_nm": fleetToolOp({
      operationId: "rank_vessels_by_emissions_per_nm",
      summary: "Rank vessels by emissions per nautical mile",
      description:
        "Rank the fleet's vessels by tank-to-wake kg CO2 per nautical mile (least efficient first, rank 1..n). " +
        "Answers 'rank my vessels by emissions per nm', 'which vessel is least efficient'. Pair with the " +
        "fleet-emissions-rank widget.",
      schema: fleetEmissionsRankDataSchema as unknown as z.ZodType,
      widget: "fleet-emissions-rank",
    }),
  };
}

/** A standard voyage tool operation: date-range body in, widget/list data out. */
function voyageToolOp(op: {
  operationId: string;
  summary: string;
  description: string;
  schema: z.ZodType;
  widget: string;
  extraProps?: Record<string, unknown>;
  approvalWidget?: string;
}): Record<string, unknown> {
  return {
    post: {
      operationId: op.operationId,
      summary: op.summary,
      description: op.description,
      // When set, the platform shows this widget as an interactive gate: it swaps the
      // tool's input schema for the widget's input schema, the user picks, and the
      // widget's output (here `{ route }`) becomes this endpoint's request body.
      ...(op.approvalWidget ? { "x-zap-approval-widget": op.approvalWidget } : {}),
      requestBody: {
        required: false,
        content: {
          "application/json": {
            schema: {
              type: "object",
              properties: {
                startDate: { type: "string", description: "ISO start date. Defaults to 12 months before endDate." },
                endDate: { type: "string", description: "ISO end date. Defaults to now." },
                search: { type: "string", description: "Filter voyages by vessel name (substring match)." },
                ...op.extraProps,
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: `${op.widget} data.`,
          content: {
            "application/json": {
              schema: widgetResponseSchema(op.schema, `${op.widget} data (see zap-widgets schema).`),
            },
          },
        },
      },
    },
  };
}

/** All voyage (voyage-overview–backed) tool operations, keyed by path. */
function buildVoyageToolPaths(): Record<string, unknown> {
  return {
    "/get_voyage_overview": voyageToolOp({
      operationId: "get_voyage_overview",
      summary: "Get the fleet's voyages",
      description:
        "Get the fleet's voyages for a date range — each with its vessel, route (departure/arrival port + " +
        "dates), completion status, attained vs required CII rating, distance, fuel, and CO2. A data list " +
        "(most-recent first) the agent can reshape into the voyage-cii-rating or vessel-voyages widgets. " +
        "Answers 'show my recent voyages', 'voyages for <vessel>', 'which voyages had the worst CII rating'.",
      schema: voyageOverviewOutputSchema as unknown as z.ZodType,
      widget: "voyage list",
    }),
    "/rank_voyages_by_carbon_cost": voyageToolOp({
      operationId: "rank_voyages_by_carbon_cost",
      summary: "Rank voyages by carbon cost",
      description:
        "Rank the fleet's voyages by EU ETS cost (most expensive first, rank 1..n), each with its vessel, " +
        "route, allowances, CO2, and attained rating. Answers 'which voyages cost the most in EU ETS', " +
        "'rank voyages by carbon cost'. Pair with the voyage-carbon-cost widget.",
      schema: voyageCarbonCostDataSchema as unknown as z.ZodType,
      widget: "voyage-carbon-cost",
    }),
    "/get_incomplete_voyages": voyageToolOp({
      operationId: "get_incomplete_voyages",
      summary: "Get incomplete voyages",
      description:
        "List the fleet's incomplete (in-progress) voyages and compare their average fuel-per-nm against " +
        "completed voyages (a short voyage's high per-nm is port manoeuvring, not waste — flagged via " +
        "`isShort`). Answers 'show incomplete voyages', 'which voyages are still open'. Pair with the " +
        "incomplete-voyages widget.",
      schema: incompleteVoyagesDataSchema as unknown as z.ZodType,
      widget: "incomplete-voyages",
    }),
    "/list_fleet_routes": voyageToolOp({
      operationId: "list_fleet_routes",
      summary: "List the fleet's routes",
      description:
        "List every route the fleet has sailed in the date range (direction-agnostic origin↔destination), " +
        "each with its voyage count, number of distinct vessels, average per-nm CO2, and a `comparable` flag " +
        "(true when the route has enough voyages to compare, default ≥2). USE THIS FIRST when the user wants " +
        "to compare emissions by route but has not named a specific route: present the comparable routes and " +
        "ASK which one to compare, then STOP and wait for the user's reply. Do NOT call " +
        "compare_emissions_by_route in the same turn, and do NOT choose a route for them. " +
        "Also answers 'what routes has my fleet sailed', 'list our routes'.",
      schema: routeListOutputSchema as unknown as z.ZodType,
      widget: "route list",
      extraProps: {
        minVoyages: { type: "integer", description: "Min voyages for a route to be marked comparable. Defaults to 2." },
      },
    }),
    "/compare_emissions_by_route": voyageToolOp({
      operationId: "compare_emissions_by_route",
      summary: "Compare emissions on a route",
      description:
        "Compare per-nm CO2 across vessels that sailed ONE route (direction-agnostic), with each voyage's " +
        "emissions per nm, the average, the spread, and the best/worst vessel. PRECONDITION: only call this " +
        "once the user has named a SPECIFIC route (passed in `route`). NEVER pick a route yourself, and NEVER " +
        "call this in the same turn you listed routes. If the user asked to 'compare emissions across routes' " +
        "WITHOUT naming one, do NOT call this — call list_fleet_routes, present the comparable routes, and " +
        "STOP so the user can choose. IMPORTANT: this tool only RETURNS the comparison data — it does NOT " +
        "render anything itself. After it returns you MUST pass the returned object straight to " +
        "show_fleet_route_emissions(result) to draw the chart; the return value already matches that widget's " +
        "input. Answers 'compare emissions by route', 'which vessel is most efficient on a lane'.",
      schema: fleetRouteEmissionsDataSchema as unknown as z.ZodType,
      widget: "fleet-route-emissions",
      extraProps: {
        route: {
          type: "string",
          description:
            "The route to compare — a direction-agnostic origin↔destination label as returned by " +
            "list_fleet_routes (e.g. 'LUANDA <-> TUXPAN'), or the route the user named.",
        },
        minVoyages: { type: "integer", description: "Min voyages for a route to qualify. Defaults to 2." },
      },
    }),
  };
}

/**
 * The two single-purpose CII chart tools (also vessel-cii–backed).
 *   - get_cii_rating_distribution: optional `year` in, cii_rating_distribution out.
 *   - get_vessel_cii_forecast: imo/vesselName in, cii_forecast_chart out.
 */
function buildCiiChartToolPaths(): Record<string, unknown> {
  return {
    "/get_cii_rating_distribution": fleetToolOp({
      operationId: "get_cii_rating_distribution",
      summary: "Get the fleet CII rating distribution (chart)",
      description:
        "DEPRECATED for fleet rating questions — prefer get_fleet_cii_ratings, which answers the fleet's CII " +
        "rating distribution/breakdown/spread, count-by-grade and at-risk questions and pairs with the " +
        "fleet-cii-rating widget (per-grade counts + % of fleet). Only use this tool if the user EXPLICITLY " +
        "asks for the alternate chart visualisation (A–E circles + proportion bar + full vessel table). " +
        "Pair with the cii-rating-distribution widget.",
      schema: ciiRatingDistributionDataSchema as unknown as z.ZodType,
      widget: "cii-rating-distribution",
    }),
    "/get_vessel_cii_forecast": {
      post: {
        operationId: "get_vessel_cii_forecast",
        summary: "Get a vessel's CII forecast",
        description:
          "Get a single vessel's CII (Carbon Intensity Indicator) forecast — its attained-AER trajectory, the " +
          "A–E rating boundary bands per year (historical through future projections), AND a speed→CII curve " +
          "showing which CII grade each sailing speed yields in future years. Identify the vessel by `imo` or " +
          "`vesselName` (one is required). Answers 'show <vessel>'s CII forecast', 'will <vessel> stay " +
          "compliant', 'CII trajectory for IMO <n>', AND speed-advice questions like 'what speed should I " +
          "maintain to keep/bring CII to a good grade', 'suggest a speed to hold throughout the year for a " +
          "good CII rating', 'how slow must <vessel> sail to stay rated A/B' — the chart's speed branches show " +
          "the grade attainable at each speed. This is THE tool for CII-vs-speed advice. Pair with the " +
          "cii-forecast-chart widget (titled 'CII Forecast - Based on speed').",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  imo: { type: "integer", description: "The vessel's 7-digit IMO number. Provide imo or vesselName." },
                  vesselName: {
                    type: "string",
                    description: "Vessel name (case-insensitive exact match). Provide imo or vesselName.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": {
            description: "cii-forecast-chart widget data.",
            content: {
              "application/json": {
                schema: widgetResponseSchema(
                  ciiForecastDataSchema as unknown as z.ZodType,
                  "cii-forecast-chart widget data (see zap-widgets schema).",
                ),
              },
            },
          },
        },
      },
    },
  };
}

/** The friend's single-vessel widget tools (emission-analytics / eu-ets / fuel / summary). */
function buildVesselWidgetToolPaths(): Record<string, unknown> {
  return {
    "/get_emission_analytics": widgetOperation({
      operationId: "get_emission_analytics",
      summary: "Get a vessel's year-to-date CII analytics",
      description:
        "Fetch a vessel's year-to-date Carbon Intensity Indicator (CII) analytics — attained CII " +
        "curve(s), A-E rating boundaries per year, and the correction-factors summary — shaped exactly " +
        "for the emission_analytics widget. After calling this, pass the result straight to " +
        "show_emission_analytics to render the chart. Use when the user asks about CII or emission " +
        "analytics for a vessel.",
      responseDescription: "Emission analytics data, ready to pass to show_emission_analytics.",
      schema: emissionAnalyticsInputSchema as unknown as z.ZodType,
    }),
    "/get_eu_ets": widgetOperation({
      operationId: "get_eu_ets",
      summary: "Get a vessel's EU ETS exposure and cost",
      description:
        "Fetch a vessel's EU ETS (EU Emissions Trading System) exposure for a compliance year — the " +
        "EU Allowance (EUA) exposure, total EUA cost in EUR, and coverage percentage — shaped exactly " +
        "for the emission_eu_ets widget. After calling this, pass the result straight to " +
        "show_emission_eu_ets to render the card. Use when the user asks about EU ETS, carbon " +
        "allowances, or EUA cost for a vessel.",
      responseDescription: "EU ETS data, ready to pass to show_emission_eu_ets.",
      schema: emissionEuEtsInputSchema as unknown as z.ZodType,
    }),
    "/get_fuel_consumption": widgetOperation({
      operationId: "get_fuel_consumption",
      summary: "Get a vessel's fuel consumption and CO2 breakdown",
      description:
        "Fetch a vessel's year-to-date fuel consumption and resulting CO2 emissions — per-fuel " +
        "consumption (VLSFO, MGO, HFO, …) with each fuel's CO2 conversion factor and CO2 output, plus " +
        "total CO2 — shaped exactly for the emission_fuel_consumption widget. After calling this, pass " +
        "the result straight to show_emission_fuel_consumption to render the breakdown. Use when the " +
        "user asks about fuel consumption, fuel burn, or CO2 emissions for a vessel.",
      responseDescription: "Fuel consumption data, ready to pass to show_emission_fuel_consumption.",
      schema: emissionFuelConsumptionInputSchema as unknown as z.ZodType,
    }),
    "/get_fleet_summary": widgetOperation({
      operationId: "get_fleet_summary",
      summary: "Get a vessel's emission summary",
      description:
        "THE tool for a single vessel's summary. Returns an at-a-glance card — vessel characteristics, " +
        "voyage performance (distance, time, speeds), attained CII with rating and 30-day trend, EU ETS " +
        "exposure and cost, and the per-fuel consumption / CO2 breakdown — shaped exactly for the " +
        "emission_fleet_summary widget. ALWAYS use this (NOT the AIS position / voyage / port-call tools) " +
        "whenever the user asks for a summary/overview of ONE named vessel (by name or IMO) — including " +
        "'fleet summary for <vessel>', 'fleet summary for a vessel <name>(<imo>)', 'summary for IMO <n>', " +
        "'emission summary', 'emission overview'. Only use the AIS position/voyage/port-call tools instead " +
        "if the user EXPLICITLY asks for the vessel's live position, voyage list, or port calls. Identify " +
        "the vessel by vesselId (IMO). After it returns, pass the result straight to " +
        "show_emission_fleet_summary to render the card.",
      responseDescription: "Emission summary data, ready to pass to show_emission_fleet_summary.",
      schema: emissionFleetSummaryInputSchema as unknown as z.ZodType,
    }),
  };
}

export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: "3.0.0",
    "x-zap": { enabled: true },
    info: {
      title: "Westship Emission Tools",
      version: "1.0.0",
      description: "Adapter that wraps the raw Westship API and shapes data for the emission widgets.",
    },
    paths: {
      ...buildVesselWidgetToolPaths(),
      ...buildFleetToolPaths(),
      ...buildVoyageToolPaths(),
      ...buildCiiChartToolPaths(),
    },
  };
}
