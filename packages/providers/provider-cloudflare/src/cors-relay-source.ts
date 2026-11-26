/**
 * Self-contained CORS relay Worker — deployed via Temporary Accounts only.
 *
 * Nested Temporary Accounts from a Temporary Worker are blocked
 * (`worker_subrequest_blocked`). Bootstrap materializes TEMP_* placeholders
 * with the temporary account credentials so POST /station uploads Environment
 * Stations onto the **same** account via Workers Scripts API only.
 *
 * Placeholders (replaced at bootstrap): __HOBO_TEMP_ACCOUNT_ID__,
 * __HOBO_TEMP_API_TOKEN__, __HOBO_CLAIM_URL__
 * Never echo the api token in JSON responses.
 */
export const CORS_RELAY_SCRIPT_NAME = "hobo-cors-relay"; // public-contract: Temporary Accounts CORS relay Worker script name

const STATION_MODULE_FOR_RELAY = `export default {
  async fetch(request) {
    const url = new URL(request.url);
    const body = {
      ok: true,
      kind: "hobo-environment-station",
      provider: "cloudflare",
      anonymous: true,
      temporary: true,
    };
    if (url.pathname === "/health") {
      return Response.json(body);
    }
    return new Response(
      '<!doctype html><html><body data-hobo-station="cloudflare" data-anonymous="true"><h1>HoBo Environment Station</h1><pre>' +
        JSON.stringify(body, null, 2) +
        "</pre></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
};
`;

/** Bundled Worker module template (placeholders filled at bootstrap). */
export const CORS_RELAY_WORKER_MODULE = [
	"const CF_API = 'https://api.cloudflare.com/client/v4';",
	"const TTL_MS = 60 * 60 * 1000;",
	"const STATION_PREFIX = 'hobo-env-station';",
	"const TEMP_ACCOUNT_ID = '__HOBO_TEMP_ACCOUNT_ID__';",
	"const TEMP_API_TOKEN = '__HOBO_TEMP_API_TOKEN__';",
	"const CLAIM_URL = '__HOBO_CLAIM_URL__';",
	"const ALLOWED = /^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:\\d+)?$|^https:\\/\\/([a-z0-9-]+\\.)*github\\.io$/iu;",
	`const STATION_MODULE = ${JSON.stringify(STATION_MODULE_FOR_RELAY)};`,
	`function corsHeaders(origin) {
  const allow = origin && ALLOWED.test(origin) ? origin : "https://tyler-r-kendrick.github.io";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, OPTIONS, GET",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...corsHeaders(origin) },
  });
}
async function readCf(response, label) {
  const body = await response.json();
  if (!response.ok || !body.success || body.result === undefined) {
    const detail = (body.errors || []).map((e) => e.message || e.code).join("; ") || ("HTTP " + response.status);
    throw new Error("Cloudflare " + label + " failed: " + detail);
  }
  return body.result;
}
function sanitizeName(stationId) {
  const compact = String(stationId).replace(/[^a-z0-9]+/gi, "").toLowerCase().slice(-24);
  return (STATION_PREFIX + "-" + (compact || "anon")).slice(0, 63);
}
async function deployStation(stationId) {
  if (!TEMP_ACCOUNT_ID || !TEMP_API_TOKEN || !CLAIM_URL || TEMP_ACCOUNT_ID.includes("__HOBO_")) {
    throw new Error("CORS relay missing materialized Temporary Account credentials");
  }
  const scriptName = sanitizeName(stationId);
  const metadata = JSON.stringify({ main_module: "station.js", compatibility_date: "2024-11-01" });
  const form = new FormData();
  form.set("metadata", new Blob([metadata], { type: "application/json" }));
  form.set("station.js", new File([STATION_MODULE], "station.js", { type: "application/javascript+module" }));
  await readCf(
    await fetch(CF_API + "/accounts/" + TEMP_ACCOUNT_ID + "/workers/scripts/" + scriptName, {
      method: "PUT",
      headers: { authorization: "Bearer " + TEMP_API_TOKEN },
      body: form,
    }),
    "workers script upload",
  );
  await fetch(CF_API + "/accounts/" + TEMP_ACCOUNT_ID + "/workers/scripts/" + scriptName + "/subdomain", {
    method: "POST",
    headers: { authorization: "Bearer " + TEMP_API_TOKEN, "content-type": "application/json" },
    body: JSON.stringify({ enabled: true }),
  }).catch(() => null);
  let host;
  try {
    const sub = await readCf(
      await fetch(CF_API + "/accounts/" + TEMP_ACCOUNT_ID + "/workers/subdomain", {
        method: "GET",
        headers: { authorization: "Bearer " + TEMP_API_TOKEN },
      }),
      "workers subdomain",
    );
    host = sub.subdomain;
  } catch (_) {}
  const stationUrl = host
    ? "https://" + scriptName + "." + host + ".workers.dev"
    : "https://" + scriptName + "." + TEMP_ACCOUNT_ID + ".workers.dev";
  return {
    ok: true,
    stationId,
    scriptName,
    stationUrl,
    claimUrl: CLAIM_URL,
    expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    anonymous: true,
    temporary: true,
  };
}
export default {
  async fetch(request) {
    const origin = request.headers.get("origin");
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return json({
        ok: true,
        service: "hobo-cors-relay",
        temporaryAccounts: true,
        sameAccountStations: true,
      }, 200, origin);
    }
    if (request.method !== "POST" || url.pathname !== "/station") {
      return json({ ok: false, error: "not-found" }, 404, origin);
    }
    let stationId = "station:anon:" + crypto.randomUUID();
    try {
      const body = await request.json();
      if (typeof body.stationId === "string" && body.stationId.length > 0) {
        stationId = body.stationId.slice(0, 128);
      }
    } catch (_) {}
    try {
      const result = await deployStation(stationId);
      return json(result, 200, origin);
    } catch (error) {
      return json({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        remediation:
          "CORS relay station deploy failed. Re-bootstrap with bootstrapCorsRelayViaTemporaryAccounts (zero permanent Cloudflare secrets).",
      }, 502, origin);
    }
  },
};
`,
].join("\n");

/** Guard: relay source must not teach permanent API token bootstrap. */
export function assertCorsRelayIsAnonymousOnly(source: string): void {
	if (
		/CLOUDFLARE_API_TOKEN/u.test(source) ||
		/CLOUDFLARE_ACCOUNT_ID/u.test(source)
	) {
		throw new Error(
			"CORS relay must not reference permanent Cloudflare API tokens",
		);
	}
	if (!/access-control-allow-origin/u.test(source)) {
		throw new Error("CORS relay must set access-control-allow-origin");
	}
	if (
		!/__HOBO_TEMP_API_TOKEN__/u.test(source) ||
		!/__HOBO_TEMP_ACCOUNT_ID__/u.test(source)
	) {
		throw new Error(
			"CORS relay template must include Temporary Account placeholders",
		);
	}
}
