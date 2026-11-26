/**
 * HoBo Cloudflare Environment Station Worker — operator bootstrap only.
 * No Bindle / app code. Deployed via temporary accounts for anonymous stations.
 */
export const ENVIRONMENT_STATION_WORKER_NAME_PREFIX = "hobo-env-station"; // public-contract: Temporary Accounts Environment Station script name prefix

// public-contract: Environment Station Worker module source for Temporary Accounts
export const ENVIRONMENT_STATION_WORKER_MODULE = `export default {
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
      "<!doctype html><html><body data-hobo-station=\\"cloudflare\\" data-anonymous=\\"true\\"><h1>HoBo Environment Station</h1><pre>" +
        JSON.stringify(body, null, 2) +
        "</pre></body></html>",
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
};
`;

/** Reject Bindle/app packaging strings in station Worker source. */
export function assertStationWorkerHasNoAppCode(source: string): void {
	const banned = [
		/\bwaspApp\b/u,
		/bindle\s*\(/iu,
		/try-site\/apps\//u,
		/opensaas/iu,
	];
	for (const pattern of banned) {
		if (pattern.test(source)) {
			throw new Error(
				`Environment Station Worker must not include app/Bindle code (${pattern})`,
			);
		}
	}
}
