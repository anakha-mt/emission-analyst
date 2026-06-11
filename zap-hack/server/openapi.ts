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

/** Best-effort JSON Schema for the widget data; falls back to a loose object on any drift. */
function widgetResponseSchema(): Record<string, unknown> {
  try {
    const schema = z.toJSONSchema(emissionAnalyticsInputSchema as unknown as z.ZodType, {
      target: "draft-7",
    }) as Record<string, unknown>;
    restoreEnumDescriptions(schema);
    return schema;
  } catch {
    return { type: "object", description: "emission_analytics widget data (see zap-widgets schema)." };
  }
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
      "/get_emission_analytics": {
        post: {
          operationId: "get_emission_analytics",
          summary: "Get a vessel's year-to-date CII analytics",
          description:
            "Fetch a vessel's year-to-date Carbon Intensity Indicator (CII) analytics — attained CII " +
            "curve(s), A-E rating boundaries per year, and the correction-factors summary — shaped exactly " +
            "for the emission_analytics widget. After calling this, pass the result straight to " +
            "show_emission_analytics to render the chart. Use when the user asks about CII or emission " +
            "analytics for a vessel.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["vesselId", "year"],
                  properties: {
                    vesselId: {
                      type: "string",
                      description: "Westship vessel identifier (or IMO number) to fetch CII for.",
                    },
                    year: {
                      type: "integer",
                      description: "Reporting year to pre-select in the CII boundaries dropdown, e.g. 2026.",
                    },
                    vesselName: {
                      type: "string",
                      description: "Optional display name shown in the widget header.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Emission analytics data, ready to pass to show_emission_analytics.",
              content: {
                "application/json": { schema: widgetResponseSchema() },
              },
            },
          },
        },
      },
    },
  };
}
