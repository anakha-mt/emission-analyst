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

import { emissionAnalyticsInputSchema } from "../../../zap-widgets/src/emission/schema/emission-analytics.js";
import { emissionEuEtsInputSchema } from "../../../zap-widgets/src/emission/schema/emission-eu-ets.js";
import { emissionFleetSummaryInputSchema } from "../../../zap-widgets/src/emission/schema/fleet-summary.js";
import { emissionFuelConsumptionInputSchema } from "../../../zap-widgets/src/emission/schema/fuel-consumption.js";

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

/** Best-effort JSON Schema for a widget's data; falls back to a loose object on any drift. */
function widgetResponseSchema(widgetSchema: z.ZodType): Record<string, unknown> {
  try {
    const schema = z.toJSONSchema(widgetSchema, {
      target: "draft-7",
    }) as Record<string, unknown>;
    restoreEnumDescriptions(schema);
    // The handler adds two sibling fields to the widget data (observability — the
    // widget itself ignores unknown keys): which source the figures came from, and
    // an optional human note when it's a fixture fallback.
    if (schema.type === "object") {
      schema.properties = {
        ...(schema.properties as Record<string, unknown> | undefined),
        dataSource: {
          type: "string",
          enum: ["live", "fixture"],
          description: "Whether the figures are live upstream data or the demo fixture fallback.",
        },
        message: {
          type: "string",
          description: "Present when data is a fixture/empty — explains why (e.g. 403 RBAC, no token).",
        },
      };
    }
    return schema;
  } catch {
    return { type: "object", description: "emission_analytics widget data (see zap-widgets schema)." };
  }
}

/** Shared request body: every tool takes the same `{ vesselId, year, vesselName? }`. */
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

/** Build one POST operation that returns a widget-shaped payload. */
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
          content: { "application/json": { schema: widgetResponseSchema(args.schema) } },
        },
      },
    },
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
          "Fetch a single vessel's at-a-glance emission summary — vessel characteristics, voyage " +
          "performance (distance, time, speeds), attained CII with rating and 30-day trend, EU ETS " +
          "exposure and cost, and the per-fuel consumption / CO2 breakdown — shaped exactly for the " +
          "emission_fleet_summary widget. After calling this, pass the result straight to " +
          "show_emission_fleet_summary to render the summary. Use when the user asks for an emission " +
          "overview or summary for a vessel.",
        responseDescription: "Emission summary data, ready to pass to show_emission_fleet_summary.",
        schema: emissionFleetSummaryInputSchema as unknown as z.ZodType,
      }),
    },
  };
}
