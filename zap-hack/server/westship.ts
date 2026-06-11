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
const BASE_URL = process.env.EMISSIONS_BASE_URL ?? "https://api.private.stage.zeronorth.app/emission-analytics-api";

/** Raw, untyped JSON straight off the upstream API. The projection layer owns the shape. */
export type RawJson = Record<string, unknown>;

/** A non-throwing upstream result: ok + HTTP status (null on network failure) + parsed body. */
export type SoftResult<T = RawJson> = { ok: boolean; status: number | null; data: T | null };

/** The widget-shaped fixture, used as the offline/denied-demo payload (projection passes it through). */
export function loadFixture(): RawJson {
  const path = fileURLToPath(
    new URL("../../../zap-widgets/src/emission/components/westship-cii.fixture.json", import.meta.url),
  );
  return JSON.parse(readFileSync(path, "utf8")) as RawJson;
}

/**
 * GET an upstream path, forwarding the operator token. Never throws: any non-2xx
 * or network failure resolves to `{ ok:false, status, data:null }`.
 */
async function softGet(
  path: string,
  query: Record<string, string | number | undefined>,
  auth?: string,
): Promise<SoftResult> {
  const base = BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`;
  const url = new URL(path.replace(/^\//, ""), base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  // eslint-disable-next-line no-console
  console.info(`[westship] GET ${url.toString()} (auth: ${auth ? "yes" : "none"})`);
  if (auth && process.env.DEBUG_LOG_TOKEN === "1") {
    // Secret — only logged when explicitly enabled. Lets you replay the call by hand.
    // eslint-disable-next-line no-console
    console.info("[westship] operator token:", auth.replace(/^Bearer\s+/i, ""));
  }

  try {
    const res = await fetch(url, {
      headers: {
        // CloudFront/WAF in front of the API rejects non-browser requests (403),
        // so present browser-like headers.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
        Referer: base,
        // `auth` is the full Authorization header value (incl. "Bearer "), forwarded as-is.
        ...(auth ? { Authorization: auth } : {}),
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // eslint-disable-next-line no-console
      console.error(`[westship] ${res.status} ${res.statusText} for ${url.pathname}: ${body.slice(0, 300)}`);
      return { ok: false, status: res.status, data: null };
    }

    const data = (await res.json()) as RawJson;
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
