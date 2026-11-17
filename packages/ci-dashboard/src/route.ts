/**
 * The dashboard as a relay route: `GET <basePath>` answers the page shell and
 * `GET <basePath>/app.js` the browser client. Every other path is left to the
 * caller's next route, the same shape as `createReadApi` in
 * `@hobo/ci-gh-actions`, so a relay serves both from one origin and the page
 * reads the read API with no cross-origin request.
 *
 * The page and the script hold no account data and need no token; the read
 * API behind them checks the account token on every request.
 */
import { readFileSync } from "node:fs";
import { dashboardCsp, renderDashboardPage } from "./page.js";

// public-contract: where a relay serves the dashboard unless told otherwise.
export const DASHBOARD_BASE_PATH = "/dashboard";

export type DashboardRouteOptions = Readonly<{
	basePath: string;
	/** The bundled browser client (`dist/client/app.js`). */
	script: string;
}>;

/** The bundled browser client, read from beside the compiled module. */
export function readDashboardScript(): string {
	for (const candidate of ["./client/app.js", "../dist/client/app.js"]) {
		try {
			return readFileSync(new URL(candidate, import.meta.url), "utf8");
		} catch {
			// Try the next place: compiled (`dist/`) or run from `src/` in tests.
		}
	}
	throw new Error(
		"the dashboard client is not built; run `pnpm --filter @hobo/ci-dashboard build`",
	);
}

const SECURITY_HEADERS: Readonly<[string, string][]> = [
	["x-content-type-options", "nosniff"],
	["referrer-policy", "no-referrer"],
	["x-frame-options", "DENY"],
];

function answer(
	status: number,
	body: string,
	headers: readonly [string, string][],
): Response {
	return new Response(body, {
		status,
		headers: [...SECURITY_HEADERS, ...headers],
	});
}

/** The dashboard route: a `Response` for its two paths, undefined for any other. */
export function createDashboardRoute(
	options: Partial<DashboardRouteOptions> = {},
): (request: Request) => Promise<Response | undefined> {
	const basePath = (options.basePath ?? DASHBOARD_BASE_PATH).replace(
		/\/+$/u,
		"",
	);
	const page = renderDashboardPage({ basePath });
	const csp = dashboardCsp();
	let script = options.script;
	return async (request) => {
		const { pathname } = new URL(request.url);
		const isPage = pathname === basePath || pathname === `${basePath}/`;
		const isScript = pathname === `${basePath}/app.js`;
		if (!isPage && !isScript) return undefined;
		if (request.method !== "GET" && request.method !== "HEAD")
			return answer(405, "the dashboard answers GET only\n", [
				["allow", "GET, HEAD"],
				["content-type", "text/plain; charset=utf-8"],
			]);
		if (isPage)
			return answer(200, page, [
				["content-type", "text/html; charset=utf-8"],
				["content-security-policy", csp],
				["cache-control", "no-store"],
			]);
		script ??= readDashboardScript();
		return answer(200, script, [
			["content-type", "text/javascript; charset=utf-8"],
			["cache-control", "no-cache"],
		]);
	};
}
