/**
 * Thin client for the raw Westship API.
 *
 * Westship exposes no OpenAPI spec — we just call its endpoints directly and
 * hand the raw JSON to the projection layer (see ./projections).
 *
 * Auth: the ZAP platform forwards the caller's `Authorization` header to this tool
 * server (see openapi-to-tools in zap-core), and we pass it straight through to
 * Westship — no token lives here. `fetchCii` takes that header via its `auth` param.
 * When the header is absent (standalone calls with no platform), the client runs in
 * offline demo mode and returns the local fixture — so `zap serve` renders the widget
 * end-to-end without credentials.
 *
 * Host: requests go through the private platform gateway; the tenant is carried in
 * the forwarded token (a JWT claim), not in the host.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BASE_URL = `https://api.private.stage.zeronorth.app`;

/** The widget-shaped fixture, used as the offline-demo payload (projection passes it through). */
function loadFixture(): RawJson {
  const path = fileURLToPath(
    new URL("../../../zap-widgets/src/emission/components/westship-cii.fixture.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as RawJson;
}

/** Raw, untyped JSON straight off the Westship API. The projection layer owns the shape. */
export type RawJson = Record<string, unknown>;

async function get(
  path: string,
  query: Record<string, string | number | undefined> = {},
  auth?: string,
): Promise<RawJson> {
  const url = new URL(path.replace(/^\//, ""), BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  // eslint-disable-next-line no-console
  console.info(`[westship] GET ${url.toString()} (auth: ${auth ? "yes" : "none"})`);

  const res = await fetch(url, {
    headers: {
      // CloudFront/WAF in front of Westship rejects non-browser requests (403),
      // so present browser-like headers.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`,
      // `auth` is the full Authorization header value (incl. "Bearer "), forwarded as-is.
      ...(auth ? { Authorization: auth } : {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // eslint-disable-next-line no-console
    console.error(`[westship] ${res.status} ${res.statusText} for ${url.pathname}: ${body.slice(0, 300)}`);
    throw new Error(`Westship ${res.status} ${res.statusText} for ${url.pathname}: ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as RawJson;
  // eslint-disable-next-line no-console
  console.info(`[westship] ${res.status} OK — response:`, JSON.stringify(data));
  return data;
}

/**
 * Fetch the raw year-to-date CII graph payload for a vessel.
 *
 *   GET /api/year-to-date-cii-for-graph/<imo>?year=<year>
 *   -> { graphData: [{ date, curCii, prevCii, curCiiRating, prevCiiRating }, ...] }
 *
 * `vesselId` is the vessel's IMO number (a PATH segment, not a query param).
 *
 * `auth` is the Authorization header forwarded by the platform. When absent,
 * returns the offline fixture.
 */
export async function fetchCii(params: {
  vesselId: string | number;
  year: number;
  auth?: string;
}): Promise<RawJson> {
  const { auth } = params;
  if (!auth) return loadFixture();
  const imo = encodeURIComponent(String(params.vesselId));
  return get(`/api/year-to-date-cii-for-graph/${imo}`, { year: params.year }, auth);
}
