import { readFileSync } from "node:fs";
import { dashboardCsp, renderDashboardPage } from "./page.js";

// public-contract: where a relay serves the dashboard unless told otherwise.
export const DASHBOARD_BASE_PATH = "/dashboard";

export type DashboardRouteOptions = Readonly<{
	basePath: string;
	script: string;
}>;

export function readDashboardScript(): string {
	for (const candidate of ["./client/app.js", "../dist/client/app.js"]) {
		try {
			return readFileSync(new URL(candidate, import.meta.url), "utf8");
		} catch {}
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
