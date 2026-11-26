import { describe, expect, it } from "vitest";

import {
	applySessionReplayToEntrypoints,
	deriveBindleSessionReplayPlan,
	isResourceReplayable,
	SESSION_REPLAY_PATH_PREFIX,
	sessionReplayAnnotation,
	wrapBindleWebHandler,
} from "../src/bindle-integration.js";
import { injectSessionReplayBootstrap } from "../src/browser-bootstrap.js";

const sampleDefinition = {
	name: "shop",
	resources: {
		storefront: {
			kind: "web",
			name: "storefront",
			annotations: [sessionReplayAnnotation()],
		},
		api: {
			kind: "api",
			name: "api",
			annotations: [sessionReplayAnnotation()],
		},
		worker: {
			kind: "service",
			name: "worker",
			annotations: [],
		},
		kv: {
			kind: "kv",
			name: "kv",
			annotations: [],
		},
		optOut: {
			kind: "web",
			name: "optOut",
			annotations: [sessionReplayAnnotation({ enabled: false })],
		},
	},
};

describe("bindle session-replay integration", () => {
	it("every App Kit is replayable by default; infra kits and explicit false opt out", () => {
		expect(isResourceReplayable(sampleDefinition.resources.storefront)).toBe(
			true,
		);
		expect(isResourceReplayable(sampleDefinition.resources.api)).toBe(true);
		// service is an App Kit even without annotation (default-on by kind)
		expect(isResourceReplayable(sampleDefinition.resources.worker)).toBe(true);
		expect(isResourceReplayable(sampleDefinition.resources.kv)).toBe(false);
		expect(isResourceReplayable(sampleDefinition.resources.optOut)).toBe(false);
	});

	it("derive plan enables local default when any App Kit exists", () => {
		const plan = deriveBindleSessionReplayPlan(sampleDefinition, {});
		expect(plan.enabled).toBe(true);
		expect(plan.reason).toBe("bindle-kit-default-on");
		expect(plan.resourceNames).toContain("storefront");
		expect(plan.resourceNames).toContain("api");
		expect(plan.resourceNames).toContain("worker");
		expect(plan.resourceNames).not.toContain("optOut");
		expect(plan.resourceNames).not.toContain("kv");
		expect(plan.pathPrefix).toBe(SESSION_REPLAY_PATH_PREFIX);
	});

	it("HOBO_REPLAY=0 disables plan", () => {
		const plan = deriveBindleSessionReplayPlan(sampleDefinition, {
			HOBO_REPLAY: "0",
		});
		expect(plan.enabled).toBe(false);
	});

	it("injects bootstrap into HTML and accepts ingest", async () => {
		const inner = async () =>
			new Response("<html><body><h1>hi</h1></body></html>", {
				headers: { "content-type": "text/html" },
			});
		const surface = wrapBindleWebHandler(inner, {
			bindleName: "shop",
			resourceName: "storefront",
			enabled: true,
		});
		const page = await surface.handler(new Request("http://127.0.0.1:4000/"));
		const html = await page.text();
		expect(html).toContain('data-hobo-replay="1"');
		expect(html).toContain('pagehide",function(){flush();stopped=true;}');
		expect(html).toContain("stop:function(){flush();stopped=true;}");
		expect(page.headers.get("x-hobo-session-replay")).toBe("1");

		const ingest = await surface.handler(
			new Request("http://127.0.0.1:4000/__hobo/replay/ingest", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					sessionId: "sess-shop-1",
					seq: 0,
					events: [
						{
							type: 3,
							timestamp: 1,
							data: {
								tagName: "input",
								type: "password",
								value: "hunter2",
							},
						},
					],
				}),
			}),
		);
		expect(ingest.status).toBe(202);
		const body = (await ingest.json()) as { ok: boolean; sessionId: string };
		expect(body.ok).toBe(true);
		const listed = await surface.listSessions();
		expect(listed.some((s) => s.id === "sess-shop-1")).toBe(true);
		expect(JSON.stringify(listed)).not.toContain("hunter2");
	});

	it("JSON API responses are not rewritten", async () => {
		const inner = async () =>
			new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
			});
		const surface = wrapBindleWebHandler(inner, {
			bindleName: "shop",
			resourceName: "storefront",
			enabled: true,
		});
		const res = await surface.handler(new Request("http://x/"));
		expect(await res.text()).toBe('{"ok":true}');
		expect(res.headers.get("x-hobo-session-replay")).toBeNull();
	});

	it("applySessionReplayToEntrypoints wraps only replayable resources", () => {
		const result = applySessionReplayToEntrypoints(
			[
				{
					name: "storefront",
					kind: "web",
					handler: async () => new Response("ok"),
				},
				{
					name: "api",
					kind: "api",
					handler: async () => new Response("api"),
				},
			],
			sampleDefinition,
			{ env: {} },
		);
		expect(result.plan.enabled).toBe(true);
		expect(result.entrypoints).toHaveLength(2);
	});

	it("bootstrap inject is idempotent", () => {
		const html = "<html><body>x</body></html>";
		const once = injectSessionReplayBootstrap(html, {
			sessionId: "s1",
			stationId: "station:local",
			bindleName: "shop",
			resourceName: "web",
			ingestPath: "/__hobo/replay/ingest",
			enabled: true,
		});
		const twice = injectSessionReplayBootstrap(once, {
			sessionId: "s2",
			stationId: "station:local",
			bindleName: "shop",
			resourceName: "web",
			ingestPath: "/__hobo/replay/ingest",
			enabled: true,
		});
		expect(twice).toBe(once);
		expect((twice.match(/data-hobo-replay/g) ?? []).length).toBe(1);
	});
});
