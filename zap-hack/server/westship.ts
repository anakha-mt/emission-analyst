/**
 * Token-forwarding client for ZeroNorth's emission-analytics-api.
 *
 * The tool server holds NO credentials. It forwards the operator's bearer token
 * (attached by the ZAP platform to every tool call) straight to the upstream API.
 * When that token isn't provisioned for emission-analytics the upstream returns
 * 403 (RBAC) — expected on stage; callers fall back to the demo fixture.
 *
 * Every upstream call is "soft": 401 / 403 / 404 / 5xx / fetch-failure resolve to
 * a `{ ok:false }` result instead of throwing, so the tool endpoint can stay
 * always-200 and decide live-vs-fixture from the data (see ./vessel-facts.ts).
 *
 * Host is `EMISSIONS_BASE_URL` (defaults to the stage emission-analytics-api). The
 * browser-like headers are needed because CloudFront/WAF rejects non-browser UAs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** emission-analytics-api base URL — override per environment with EMISSIONS_BASE_URL. */
const BASE_URL = "https://api.private.stage.zeronorth.app/emission-analytics-api";

/**
 * vessel-particulars-api-2 base — a SIBLING service on the same gateway as the
 * emission-analytics API. Derived from BASE_URL (swap the service path segment)
 * so the host stays tied to BASE_URL: no second host hardcoded, no token wiring.
 * Backs the CII-forecast speed→consumption curve (vessel draught + fuel model).
 */
const PARTICULARS_BASE = BASE_URL.replace(/\/emission-analytics-api\/?$/, "/vessel-particulars-api-2");

/** Raw, untyped JSON straight off the upstream API. The projection layer owns the shape. */
export type RawJson = Record<string, unknown>;

/** A non-throwing upstream result: ok + HTTP status (null on network failure) + parsed body. */
export type SoftResult<T = RawJson> = { ok: boolean; status: number | null; data: T | null };

/** Names of the widget-shaped fixtures shipped by zap-widgets, keyed to their files. */
const FIXTURE_FILES = {
  cii: "westship-cii.fixture.json",
  "fleet-summary": "westship-fleet-summary.fixture.json",
  "eu-ets": "westship-eu-ets.fixture.json",
  "fuel-consumption": "westship-fuel-consumption.fixture.json",
} as const;

export type FixtureName = keyof typeof FIXTURE_FILES;

/**
 * Load a widget-shaped fixture, used as the offline/denied-demo payload (the
 * projection's fast path passes it straight through). Defaults to the CII fixture.
 */
export function loadFixture(name: FixtureName = "cii"): RawJson {
  const path = fileURLToPath(
    new URL(`../../../zap-widgets/src/emission/components/${FIXTURE_FILES[name]}`, import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as RawJson;
}

/**
 * Browser-like headers + forwarded operator token. CloudFront/WAF in front of the
 * gateway rejects non-browser requests (403), so we present a browser UA. `auth` is
 * the full Authorization header value (incl. "Bearer "), forwarded as-is.
 */
function buildHeaders(auth: string | undefined, base: string, extra?: Record<string, string>): Record<string, string> {
  return {

    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    Referer: base,
    ...(extra ?? {}),
    ...(auth ? { Authorization: auth } : {}),
  };
}

/** Log a soft response uniformly (row count when the body is a `{ data: [...] }` page). */
function logResponse(status: number, pathname: string, data: RawJson): void {
  const rows = Array.isArray((data as { data?: unknown }).data) ? (data as { data: unknown[] }).data.length : undefined;
  // eslint-disable-next-line no-console
  console.info(`[westship] ${status} OK for ${pathname}${rows !== undefined ? ` — ${rows} rows` : ""}`);
  // eslint-disable-next-line no-console
  console.info(`[westship] response:`, JSON.stringify(data));
}

/**
 * GET an upstream path, forwarding the operator token. Never throws: any non-2xx
 * or network failure resolves to `{ ok:false, status, data:null }`. `base` selects
 * the service (defaults to emission-analytics; pass PARTICULARS_BASE for the other).
 */
async function softGet(
  path: string,
  query: Record<string, string | number | undefined>,
  auth?: string,
  baseUrl: string = BASE_URL,
): Promise<SoftResult> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\//, ""), base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  if (auth && process.env.DEBUG_LOG_TOKEN === "1") {
    // Secret — only logged when explicitly enabled. Lets you replay the call by hand.
    // eslint-disable-next-line no-console
    console.info("[westship] operator token:", auth.replace(/^Bearer\s+/i, ""));
  }

  try {
    const res = await fetch(url, { headers: buildHeaders(auth, base) });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error(`[westship] ${res.status} ${res.statusText} for ${url.pathname}: ${body.slice(0, 300)}`);
      return { ok: false, status: res.status, data: null };
    }

    const data = (await res.json()) as RawJson;
    logResponse(res.status, url.pathname, data);
    return { ok: true, status: res.status, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[westship] fetch_failed for ${url.pathname}: ${message}`);
    return { ok: false, status: null, data: null };
  }
}

/**
 * POST a JSON body to an upstream path, forwarding the operator token. Soft —
 * never throws (same contract as softGet). Used for the consumption-evaluation
 * call, which takes a body rather than a query.
 */
async function softPost(
  path: string,
  body: unknown,
  auth?: string,
  baseUrl: string = BASE_URL,
): Promise<SoftResult> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(path.replace(/^\//, ""), base);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(auth, base, { "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error(`[westship] ${res.status} ${res.statusText} for ${url.pathname}: ${errBody.slice(0, 300)}`);
      return { ok: false, status: res.status, data: null };
    }

    const data = (await res.json()) as RawJson;
    logResponse(res.status, url.pathname, data);
    return { ok: true, status: res.status, data };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`[westship] fetch_failed for ${url.pathname}: ${message}`);
    return { ok: false, status: null, data: null };
  }
}

/**
 * Fetch the raw year-to-date CII graph payload for a vessel (soft — never throws).
 *
 *   GET {EMISSIONS_BASE_URL}/year-to-date-cii-for-graph/<imo>?year=<year>
 *   -> { graphData: [{ date, curCii, prevCii, curCiiRating, prevCiiRating }, ...], ... }
 *
 * `vesselId` is the vessel's IMO number (a PATH segment).
 */
export async function fetchCiiGraph(params: {
  vesselId: string | number;
  year: number;
  auth?: string;
}): Promise<SoftResult> {
  const imo = encodeURIComponent(String(params.vesselId));
  return softGet(`/year-to-date-cii-for-graph/${imo}`, { year: params.year }, params.auth);
}

/**
 * Fetch the raw vessel-details payload (soft — never throws). One call feeds the
 * EU ETS, fuel-consumption, and fleet-summary widgets.
 *
 *   GET {EMISSIONS_BASE_URL}/vessel-details/<imo>?year=<year>
 *   -> { imo, shipCiiType, dwt, iceClass, referenceCII, performance, aer,
 *        fuelConsumption, vesselEuEtsExposure, ... }
 *
 * `vesselId` is the vessel's IMO number (a PATH segment).
 */
export async function fetchVesselDetails(params: {
  vesselId: string | number;
  year: number;
  auth?: string;
}): Promise<SoftResult> {
  const imo = encodeURIComponent(String(params.vesselId));
  return softGet(`/vessel-details/${imo}`, { year: params.year }, params.auth);
}

/**
 * Fetch the fleet's per-vessel CII ratin
 * gs for a reporting year (soft — never throws).
 *
 *   GET {EMISSIONS_BASE_URL}/vessel-cii?year=<year>&offset=<n>&limit=<n>&...
 *   -> { data: [{ imo, vesselName, rating, co2TtwEmissions, distanceSailed,
 *                 voyageCount, fuelEuComplianceBal, euas, liveCost, ... }, ...], count }
 *
 * Backs the fleet CII-ratings, emissions-overview, compliance-risk, ETS-cost and
 * emissions-per-nm tools. Query mirrors the emission-analytics `/vessel-cii`
 * contract; `offset`/`limit` page through the fleet (default: first 100 vessels).
 */
export async function fetchVesselCii(params: {
  year: number;
  auth?: string;
  offset?: number;
  limit?: number;
}): Promise<SoftResult> {
  // Minimal query (like fetchCiiGraph) — just the year + pagination. The filter
  // block (myVessel=false, segments, eligibility flags) was dropped: myVessel=false
  // in particular can exclude the whole fleet. Let the upstream apply its defaults.
  return softGet(
    "/vessel-cii",
    { year: params.year, offset: params.offset ?? 0, limit: params.limit ?? 100 },
    params.auth,
  );
}

/**
 * Fetch the fleet's voyages for a date range (soft — never throws).
 *
 *   GET {EMISSIONS_BASE_URL}/voyage-overview?startDate=<iso>&endDate=<iso>&offset=<n>&limit=<n>&...
 *   -> { data: [{ imo, vesselName, voyageId, departure, arrival, isCompleted,
 *                 totalDistance, co2TtwEmissions, euas, liveCost, ... }, ...], count }
 *
 * Backs the voyage-overview, carbon-cost, incomplete-voyages and route-comparison
 * tools. Query mirrors the emission-analytics `/voyage-overview` contract;
 * `offset`/`limit` page through the voyages (default: first 50).
 */
export async function fetchVoyageOverview(params: {
  startDate: string;
  endDate: string;
  search?: string;
  auth?: string;
  offset?: number;
  limit?: number;
}): Promise<SoftResult> {
  // Minimal query (like fetchVesselCii) — date range + pagination + optional search.
  // The filter block (myVessel=false, segments, euMrvVoyages/spotVoyages,
  // includeDisabledVessels) was dropped: on the api.private gateway `myVessel=false`
  // excludes the whole fleet → 0 voyages (the same trap that zeroed out /vessel-cii).
  // Let the upstream apply its defaults so the fleet's voyages come back.
  return softGet(
    "/voyage-overview",
    {
      startDate: params.startDate,
      endDate: params.endDate,
      offset: params.offset ?? 0,
      limit: params.limit ?? 50,
      search: params.search ?? undefined,
    },
    params.auth,
  );
}

/**
 * Fetch a vessel's static particulars by IMO (soft — never throws).
 *
 *   GET {PARTICULARS_BASE}/v1/vessels/<imo>  ->  { imo, vessel_name, max_draught, ... }
 *
 * Used by the CII forecast to get `max_draught` (the draft fed into the
 * consumption model). Hits the vessel-particulars-api-2 sibling service.
 */
export async function fetchVesselParticulars(params: { imo: number; auth?: string }): Promise<SoftResult> {
  const imo = encodeURIComponent(String(params.imo));
  return softGet(`/v1/vessels/${imo}`, {}, params.auth, PARTICULARS_BASE);
}

/**
 * Evaluate fuel consumption for a sweep of speed/draft points (soft — never throws).
 *
 *   POST {PARTICULARS_BASE}/v1/consumption/evaluate-consumption
 *        { baseline_choices, evaluations: [...], fuel_model_version, model_selection }
 *   -> { consumptions: [{ consumption, power }, ...] }   (aligned to evaluations order)
 *
 * Returns the consumption per evaluated speed, from which the forecast derives the
 * per-speed AER and CII rating curve. Hits the vessel-particulars-api-2 service.
 */
export async function evaluateConsumption(params: { body: unknown; auth?: string }): Promise<SoftResult> {
  return softPost("/v1/consumption/evaluate-consumption", params.body, params.auth, PARTICULARS_BASE);
}
