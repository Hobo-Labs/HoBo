import { describe, expect, it } from "vitest";
import {
	bindleCloudflareWorker,
	type CloudflareBindleContext,
	cloudflareBindings,
	inspectCloudflareWorker,
} from "../src/cloudflare-runtime.js";

const declaration = (
	kind: string,
	name: string,
	declaredAllow: string[],
	dependsOn: string[] = [],
) => ({
	kind,
	name,
	stableId: `${kind}:${name}`,
	declaredAllow,
	dependsOn,
	annotations:
		kind === "web"
			? [
					{
						provider: "hobo",
						option: "session-replay",
						config: { enabled: false },
					},
				]
			: [],
});

describe("Cloudflare worker binding", () => {
	it("routes a UI dependency as an HTTP service without UI operation grants", async () => {
		const entrypoint = (context?: CloudflareBindleContext) => async () =>
			cloudflareBindings(context)
				.service("panel")
				.fetch(new Request("https://panel.test/"));
		const app = {
			name: "shop",
			resources: {
				web: declaration("web", "web", [], ["ui"]),
				panel: declaration("ui", "panel", []),
			},
			edges: [{ from: "web", to: "panel" }],
			requirements: {},
			entrypoint: () => entrypoint,
		};
		const worker = bindleCloudflareWorker(app, "web");
		expect(inspectCloudflareWorker(worker)?.bindings).toEqual([
			{
				name: "panel",
				kind: "service",
				env: "HOBO_RESOURCE_0",
				allow: ["fetch"],
			},
		]);
		const response = await worker.fetch(new Request("https://app.test/"), {
			HOBO_RESOURCE_0: { fetch: () => new Response("panel") },
		});
		expect(await response.text()).toBe("panel");
		for (const operation of ["render", "drive"]) {
			const denied = {
				...app,
				resources: {
					...app.resources,
					panel: declaration("ui", "panel", [operation]),
				},
			};
			expect(() => bindleCloudflareWorker(denied, "web")).toThrow(
				"ui operation is unsupported",
			);
		}
	});
	it("invokes the native service using captured intrinsics", async () => {
		const entrypoint = (context?: CloudflareBindleContext) => async () =>
			cloudflareBindings(context)
				.service("catalog")
				.fetch(new Request("https://service.test/"));
		const app = {
			name: "shop",
			resources: {
				web: declaration("web", "web", [], ["service"]),
				catalog: declaration("service", "catalog", []),
			},
			edges: [{ from: "web", to: "catalog" }],
			requirements: {},
			entrypoint: (name: string) => (name === "web" ? entrypoint : undefined),
		};
		const worker = bindleCloudflareWorker(app, "web");
		let receiverCorrect = false;
		const service = {
			fetch() {
				receiverCorrect = this === service;
				return new Response("original");
			},
		};
		const original = Reflect.apply;
		let substituted = 0;
		Reflect.apply = () => {
			substituted++;
			throw new Error("substituted intrinsic");
		};
		let pending: Promise<Response>;
		try {
			pending = worker.fetch(new Request("https://app.test/"), {
				HOBO_RESOURCE_0: service,
			});
		} finally {
			Reflect.apply = original;
		}
		expect(await (await pending).text()).toBe("original");
		expect(receiverCorrect).toBe(true);
		expect(substituted).toBe(0);
	});

	it("invokes the bindle handler with only its declared service binding", async () => {
		const entrypoint = (context?: CloudflareBindleContext) => async () => {
			const services = cloudflareBindings(context);
			expect(() => services.service("other")).toThrow("resource is not bound");
			return services
				.service("catalog")
				.fetch(new Request("https://service.test/item"));
		};
		const app = {
			name: "shop",
			resources: {
				web: declaration("web", "web", [], ["service"]),
				catalog: declaration("service", "catalog", []),
			},
			edges: [{ from: "web", to: "catalog" }],
			requirements: {},
			entrypoint: (name: string) => (name === "web" ? entrypoint : undefined),
		};
		const worker = bindleCloudflareWorker(app, "web");
		expect(inspectCloudflareWorker(worker)?.entrypoint).toBe(entrypoint);
		expect(inspectCloudflareWorker(worker)?.bindings).toEqual([
			{
				name: "catalog",
				kind: "service",
				env: "HOBO_RESOURCE_0",
				allow: ["fetch"],
			},
		]);
		const response = await worker.fetch(new Request("https://example.test/"), {
			HOBO_RESOURCE_0: {
				async fetch(request: Request) {
					return new Response(new URL(request.url).pathname);
				},
			},
		});
		expect(await response.text()).toBe("/item");
		await expect(
			worker.fetch(new Request("https://example.test/"), {
				HOBO_RESOURCE_0: {
					async fetch() {
						return "not a response";
					},
				},
			}),
		).rejects.toThrow("invalid response");
	});

	it.each([
		["bucket", "blob metadata, events and presigned URLs"],
		["kv", "WASI store semantics and consistency"],
		["queue", "idempotency and receipt semantics"],
	])("rejects an incomplete %s runtime before generating a worker", (kind, reason) => {
		const app = {
			name: "shop",
			resources: {
				web: declaration("web", "web", [], [kind]),
				dependency: declaration(kind, "dependency", []),
			},
			edges: [{ from: "web", to: "dependency" }],
			requirements: {},
			entrypoint: () => () => () => new Response("ok"),
		};
		expect(() => bindleCloudflareWorker(app, "web")).toThrow(reason);
	});

	it("rejects enabled replay before generating a worker", () => {
		const app = {
			name: "shop",
			resources: { web: declaration("web", "web", []) },
			edges: [],
			requirements: {},
			entrypoint: () => () => () => new Response("ok"),
		};
		app.resources.web.annotations[0].config.enabled = true;
		expect(() => bindleCloudflareWorker(app, "web")).toThrow("session replay");
	});
});
