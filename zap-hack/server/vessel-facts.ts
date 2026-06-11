/**
 * The fact-gathering hub for emission analytics — the single source of truth for
 * one vessel's CII data and the live-vs-fixture decision.
 *
 * Keeping this in one place means the handler stays thin and the "is this real
 * data or the demo fixture?" decision lives in exactly one spot.
 *
 * - Calls the emission-analytics graph endpoint via a soft (non-throwing) fetch.
 * - Usable upstream data            -> dataSource:"live".
 * - Denied (403 RBAC) / empty / down -> demo fixture, dataSource:"fixture", with a
 *   `message` explaining why.
 *
 * DEBUG_FACTS=1 logs one line per call — which endpoint was LIVE vs — and the
 * first upstream status (403 = the emission-analytics role isn't granted yet).
 */
import { fetchCiiGraph, loadFixture, type RawJson } from "./westship.js";

export type DataSource = "live" | "fixture";

export type CiiFacts = {
  raw: RawJson;
  dataSource: DataSource;
  firstUpstreamStatus: number | null;
  message?: string;
};

function debugFacts(imo: string | number, ytdCiiGraph: "LIVE" | "—", firstUpstreamStatus: number | null): void {
  if (process.env.DEBUG_FACTS !== "1") return;
  // eslint-disable-next-line no-console
  console.info(`[facts] imo=${imo} ytd-cii-graph=${ytdCiiGraph} firstUpstreamStatus=${firstUpstreamStatus}`);
}

/** True when the graph payload actually carries a CII curve we can render. */
function hasUsableGraph(data: RawJson | null): boolean {
  const graph = data?.["graphData"];
  return Array.isArray(graph) && graph.length > 0;
}

/**
 * Gather one vessel's year-to-date CII facts, deciding live-vs-fixture.
 *
 * No operator token (running standalone, without the platform) goes straight to
 * the fixture so `zap serve` renders the widget end-to-end without credentials.
 */
export async function gatherCiiFacts(params: {
  vesselId: string | number;
  year: number;
  auth?: string;
}): Promise<CiiFacts> {
  const { vesselId, year, auth } = params;

  if (!auth) {
    debugFacts(vesselId, "—", null);
    return {
      raw: loadFixture(),
      dataSource: "fixture",
      firstUpstreamStatus: null,
      message: "No operator token (running without the platform) — showing demo fixture.",
    };
  }

  const res = await fetchCiiGraph({ vesselId, year, auth });
  const live = res.ok && hasUsableGraph(res.data);
  debugFacts(vesselId, live ? "LIVE" : "—", res.status);

  if (live && res.data) {
    return { raw: res.data, dataSource: "live", firstUpstreamStatus: res.status };
  }

  const why =
    res.status === 403
      ? "emission-analytics access is not granted for this token (403 RBAC)"
      : res.status === null
        ? "the upstream was unreachable (fetch failed)"
        : res.ok
          ? "the upstream returned no CII curve"
          : `the upstream returned ${res.status}`;
  return {
    raw: loadFixture(),
    dataSource: "fixture",
    firstUpstreamStatus: res.status,
    message: `Showing demo fixture — ${why}.`,
  };
}
