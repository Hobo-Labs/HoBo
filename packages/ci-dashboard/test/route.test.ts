import { describe, expect, it } from "vitest";
import {
	createDashboardRoute,
	DASHBOARD_VIEWS,
	THEME_BOOT_SCRIPT,
} from "../src/index.js";

const ORIGIN = "https://relay.example.test";
const route = createDashboardRoute({ script: "/* client */" });

describe("the dashboard route", () => {
	it("serves the page shell with a strict CSP and every view in its navigation", async () => {
		const answer = await route(new Request(`${ORIGIN}/dashboard`));
		expect(answer?.status).toBe(200);
		expect(answer?.headers.get("content-type")).toBe(
			"text/html; charset=utf-8",
		);
		const csp = answer?.headers.get("content-security-policy") ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("connect-src 'self'");
		expect(csp).toContain("form-action 'none'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/u);
		expect(csp).not.toContain("'unsafe-eval'");
		expect(answer?.headers.get("x-frame-options")).toBe("DENY");
		const html = (await answer?.text()) ?? "";
		for (const view of DASHBOARD_VIEWS)
			expect(html).toContain(`href="#/${view}"`);
		expect(html).toContain('<script src="/dashboard/app.js" defer></script>');
		expect(html).toContain(`<script>${THEME_BOOT_SCRIPT}</script>`);
	});

	it("serves the client script", async () => {
		const answer = await route(new Request(`${ORIGIN}/dashboard/app.js`));
		expect(answer?.headers.get("content-type")).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(await answer?.text()).toBe("/* client */");
	});

	it("answers GET only", async () => {
		const answer = await route(
			new Request(`${ORIGIN}/dashboard`, { method: "POST", body: "{}" }),
		);
		expect(answer?.status).toBe(405);
		expect(answer?.headers.get("allow")).toBe("GET, HEAD");
	});

	it("leaves every other path to the caller's next route", async () => {
		expect(
			await route(new Request(`${ORIGIN}/v1/accounts/self/machines`)),
		).toBe(undefined);
		expect(await route(new Request(`${ORIGIN}/dashboards`))).toBe(undefined);
	});

	it("mounts at another base path", async () => {
		const mounted = createDashboardRoute({ basePath: "/ci/", script: "" });
		const html = await (await mounted(new Request(`${ORIGIN}/ci`)))?.text();
		expect(html).toContain('<script src="/ci/app.js" defer></script>');
	});

	it("reads the built client when given none", async () => {
		const built = createDashboardRoute();
		const answer = await built(new Request(`${ORIGIN}/dashboard/app.js`));
		expect((await answer?.text())?.length ?? 0).toBeGreaterThan(1000);
	});
});
