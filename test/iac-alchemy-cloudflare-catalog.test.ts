import { describe, expect, it } from "vitest";
import {
	bindle,
	continuity,
	sessionReplay,
} from "../packages/bindles/src/index.js";
import { CATALOG_ROWS } from "../packages/bindles/src/types.js";
import { mapBindleToAlchemy } from "../packages/iac/iac-alchemy/src/bindle.js";
import {
	cloudflareBindleMappers,
	cloudflareViteApp,
	describeCloudflarePrimitiveSupport,
} from "../packages/iac/iac-alchemy/src/cloudflare.js";
import {
	bindleCloudflareWorker,
	cloudflareBindings,
} from "../packages/iac/iac-alchemy/src/cloudflare-runtime.js";

const sourceFence = {
	sourceDigest: `sha256:${"a".repeat(64)}`,
	environmentDigest: `sha256:${"b".repeat(64)}`,
	proofRef: "test:source-fence",
	verify: () => true,
};

describe("Cloudflare coverage of the real HoBo catalog", () => {
	it("reports every catalog primitive and explains each supported or unavailable capability", () => {
		const support = describeCloudflarePrimitiveSupport(CATALOG_ROWS);
		expect(support.map((row) => row.kind)).toEqual(
			CATALOG_ROWS.map((row) => row.factory),
		);
		expect(support.every((row) => row.reason.length > 0)).toBe(true);
		expect(
			support.filter((row) => row.status === "partial").map((row) => row.kind),
		).toEqual([
			"api",
			"kv",
			"bucket",
			"queue",
			"secret",
			"data",
			"web",
			"service",
			"flag",
		]);
		expect(support.filter((row) => row.status === "unsupported")).toHaveLength(
			CATALOG_ROWS.length - 9,
		);
		expect(
			support.find((row) => row.kind === "queue")?.unsupportedOperations,
		).toEqual(["enqueue", "dequeue"]);
		expect(support.find((row) => row.kind === "topic")?.reason).toContain(
			"not a multi-subscriber",
		);
	});

	it("runs a real bindle entrypoint against its declared Worker service binding", async () => {
		const application = bindle("shop", (builder) => {
			const catalog = builder
				.service(() => async () => new Response("catalog"))
				.with(sessionReplay({ enabled: false }));
			const web = builder
				.web((context) => async () => {
					const resources = cloudflareBindings(context);
					return resources
						.service("catalog")
						.fetch(new Request("https://service.test/item"));
				})
				.with(sessionReplay({ enabled: false }))
				.dependsOn(catalog);
			return { catalog, web };
		});
		const worker = bindleCloudflareWorker(application, "web");
		const calls: string[] = [];
		const response = await worker.fetch(new Request("https://example.test"), {
			HOBO_RESOURCE_0: {
				async fetch(request: Request) {
					calls.push(new URL(request.url).pathname);
					return new Response("ok");
				},
			},
		});
		expect(await response.text()).toBe("ok");
		expect(calls).toEqual(["/item"]);
	});

	it("attaches a provider-owned Vite app marker to a real HoBo web declaration", () => {
		const application = bindle("site", (builder) => ({
			web: builder
				.web(cloudflareViteApp("."))
				.with(sessionReplay({ enabled: false })),
		}));
		expect(application.resources.web?.annotations).toContainEqual({
			provider: "hobo",
			option: "webapp",
			config: { framework: "vite", root: "." },
		});
		expect(() =>
			mapBindleToAlchemy(
				application,
				cloudflareBindleMappers({ workerModules: {}, sourceFence }),
				{
					assessRequirements: () => ({ status: "supported" }),
				},
			),
		).not.toThrow();
	});

	it("refuses the default session-replay requirement and queue semantics rather than dropping them", () => {
		const defaultReplay = bindle("app", (b) => ({
			web: b.web(() => () => new Response("ok")),
		}));
		const options = {
			assessRequirements: () => ({ status: "supported" as const }),
		};
		expect(() =>
			mapBindleToAlchemy(
				defaultReplay,
				cloudflareBindleMappers({ workerModules: { web: "./worker.ts" } }),
				options,
			),
		).toThrow("session replay");
		const queue = bindle("app", (b) => ({ jobs: b.queue().allow("enqueue") }));
		expect(() =>
			mapBindleToAlchemy(
				queue,
				cloudflareBindleMappers({ workerModules: {} }),
				options,
			),
		).toThrow("PRIMITIVE_UNSUPPORTED");
		for (const storage of [
			bindle("app", (b) => ({ data: b.bucket().allow("read") })),
			bindle("app", (b) => ({ data: b.kv().allow("get") })),
		]) {
			expect(() =>
				mapBindleToAlchemy(
					storage,
					cloudflareBindleMappers({ workerModules: {} }),
					options,
				),
			).toThrow("PRIMITIVE_UNSUPPORTED");
		}
	});

	it("refuses unimplemented continuity guarantees for each native storage primitive", () => {
		const options = {
			assessRequirements: () => ({ status: "supported" as const }),
		};
		const mappers = cloudflareBindleMappers({ workerModules: {} });
		for (const application of [
			bindle("app", (b) => ({ data: b.bucket().with(continuity()) })),
			bindle("app", (b) => ({ data: b.kv().with(continuity()) })),
			bindle("app", (b) => ({ data: b.queue().with(continuity()) })),
		]) {
			expect(() => mapBindleToAlchemy(application, mappers, options)).toThrow(
				"annotation hobo:continuity",
			);
		}
		for (const kind of ["bucket", "kv", "queue"]) {
			const entry = describeCloudflarePrimitiveSupport(CATALOG_ROWS).find(
				(row) => row.kind === kind,
			);
			expect(entry?.supportedAnnotations).not.toContain("hobo:continuity");
		}
	});
});
