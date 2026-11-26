import type { ComponentHostEvent } from "@hobo/core";
import { first } from "@hobo/core/total-access";
import { describe, expect, it } from "vitest";
import {
	ComponentHostError,
	ComponentTrapError,
	createInProcessWasmtimeEngine,
	createRuntimeLocalComponentHost,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";
import {
	helloBindleComponent,
	helloBindleProvider,
} from "./fixtures/hello-bindle.js";

interface EventCollector {
	events: ComponentHostEvent[];
	appendEvent: (event: ComponentHostEvent) => void;
}

function collectEvents(): EventCollector {
	const events: ComponentHostEvent[] = [];
	return {
		events,
		appendEvent: (event) => {
			events.push(event);
		},
	};
}

describe("runtime-local component host", () => {
	it("runs an HTTP component through a static in-process link table", async () => {
		const sink = collectEvents();
		const host = createRuntimeLocalComponentHost({
			engine: createInProcessWasmtimeEngine({ version: "wasmtime@46.0.1" }),
			appendEvent: sink.appendEvent,
		});

		host.registerProvider({
			id: "local-http",
			exports: {
				"wasi:http/outgoing-handler@0.2.0": {
					handle: async (request: { path: string }) => ({
						status: 200,
						headers: [["x-provider", "runtime-local"]],
						body: `provider:${request.path}`,
					}),
				},
			},
		});

		host.loadComponent({
			parsed: true,
			id: "api",
			imports: ["wasi:http/outgoing-handler@0.2.0"],
			exports: {
				"wasi:http/incoming-handler@0.2.0": {
					handle: async (
						request: { path: string },
						context: {
							callImport: (
								importInterface: string,
								operation: string,
								payload?: JsonValue,
							) => Promise<JsonValue>;
						},
					) => {
						interface UpstreamHttp {
							status: number;
							headers: [string, string][];
							body: string;
						}
						const raw = await context.callImport(
							"wasi:http/outgoing-handler@0.2.0",
							"handle",
							request,
						);
						// SAFETY: outgoing handler returns HTTP fields at this test boundary.
						const upstream = raw as UpstreamHttp;
						return {
							status: upstream.status,
							headers: upstream.headers,
							body: `guest:${upstream.body}`,
						};
					},
				},
			},
		});

		host.link({
			componentId: "api",
			importInterface: "wasi:http/outgoing-handler@0.2.0",
			providerId: "local-http",
			exportInterface: "wasi:http/outgoing-handler@0.2.0",
		});

		const response = await host.handleHttp("api", {
			method: "GET",
			path: "/healthz",
			headers: [],
			body: "",
		});

		expect(response).toEqual({
			status: 200,
			headers: [["x-provider", "runtime-local"]],
			body: "guest:provider:/healthz",
		});
		expect(sink.events.map((event) => event.type)).toEqual([
			"component.Loaded",
			"link.Established",
			"link.Called",
			"component.Invoked",
		]);
		expect(host.engine.kind).toBe("wasmtime");
	});

	it("supports direct in-process import-to-export invocation", async () => {
		const sink = collectEvents();
		const host = createRuntimeLocalComponentHost({
			appendEvent: sink.appendEvent,
		});
		host.registerProvider({
			id: "clock",
			exports: {
				"wasi:clocks/monotonic-clock@0.2.0": {
					now: () => ({ nanoseconds: 123n }),
				},
			},
		});
		host.loadComponent({
			parsed: true,
			id: "worker",
			imports: ["wasi:clocks/monotonic-clock@0.2.0"],
			exports: {},
		});
		host.link({
			componentId: "worker",
			importInterface: "wasi:clocks/monotonic-clock@0.2.0",
			providerId: "clock",
			exportInterface: "wasi:clocks/monotonic-clock@0.2.0",
		});

		const value = await host.invokeLinkedImport(
			"worker",
			"wasi:clocks/monotonic-clock@0.2.0",
			"now",
		);

		expect(value).toEqual({ nanoseconds: 123n });
		const last = sink.events.at(-1);
		expect(last?.type).toBe("link.Called");
		if (last?.type === "link.Called") {
			expect(last.boundaryMode).toBe("live");
			expect(last.transport).toBe("in-process");
		}
	});

	it("rejects unlinked imports with no_route", async () => {
		const host = createRuntimeLocalComponentHost({ appendEvent: () => {} });
		host.loadComponent({
			parsed: true,
			id: "orphan",
			imports: ["wasi:keyvalue/store@0.2.0"],
			exports: {},
		});

		await expect(
			host.invokeLinkedImport("orphan", "wasi:keyvalue/store@0.2.0", "get"),
		).rejects.toMatchObject({
			code: "no_route",
		});
	});

	it("component traps fail the call without taking down the host", async () => {
		const host = createRuntimeLocalComponentHost({ appendEvent: () => {} });
		host.loadComponent({
			parsed: true,
			id: "bad-api",
			imports: [],
			exports: {
				"wasi:http/incoming-handler@0.2.0": {
					handle: () => {
						throw new Error("guest panic");
					},
				},
			},
		});
		host.loadComponent({
			parsed: true,
			id: "healthy-api",
			imports: [],
			exports: {
				"wasi:http/incoming-handler@0.2.0": {
					handle: () => ({ status: 204, headers: [], body: "" }),
				},
			},
		});

		await expect(
			host.handleHttp("bad-api", {
				method: "GET",
				path: "/panic",
				headers: [],
				body: "",
			}),
		).rejects.toBeInstanceOf(ComponentTrapError);

		expect(
			await host.handleHttp("healthy-api", {
				method: "GET",
				path: "/ok",
				headers: [],
				body: "",
			}),
		).toEqual({ status: 204, headers: [], body: "" });
		expect(host.lifecycle("bad-api").state).toBe("loaded");
	});

	it("teardown releases leases and removes routes for unloaded components", async () => {
		const host = createRuntimeLocalComponentHost({ appendEvent: () => {} });
		host.registerProvider({
			id: "kv",
			exports: {
				"wasi:keyvalue/store@0.2.0": {
					get: () => "value",
				},
			},
		});
		host.loadComponent({
			parsed: true,
			id: "uses-kv",
			imports: ["wasi:keyvalue/store@0.2.0"],
			exports: {},
			leases: ["memory:uses-kv", "fd:fixture"],
		});
		host.link({
			componentId: "uses-kv",
			importInterface: "wasi:keyvalue/store@0.2.0",
			providerId: "kv",
			exportInterface: "wasi:keyvalue/store@0.2.0",
		});

		expect(host.activeLeases()).toHaveLength(2);
		await host.teardownComponent("uses-kv");

		expect(host.activeLeases()).toEqual([]);
		expect(host.linkTable()).toEqual([]);
		await expect(
			host.invokeLinkedImport("uses-kv", "wasi:keyvalue/store@0.2.0", "get"),
		).rejects.toBeInstanceOf(ComponentHostError);
	});

	it("host report records HOBO-17 boundaries and fuel epoch follow-up", () => {
		const host = createRuntimeLocalComponentHost({ appendEvent: () => {} });

		expect(host.report()).toEqual({
			schema: "hobo.component-host.runtime-local/v1",
			hostKind: "runtime-local",
			engine: "wasmtime",
			supportedBoundaryModes: ["live"],
			supportedTransports: ["in-process"],
			scopeIn: [
				"component lifecycle",
				"static link table",
				"wasi:http incoming-handler demo",
				"trap isolation",
				"clean teardown",
			],
			scopeOut: [
				"cross-process lattice transport",
				"container packaging",
				"deny-by-default grant inference",
				"deterministic-clock replay",
			],
			followUps: ["fuel/epoch execution limits"],
		});
	});

	it("loads hello-bindle and returns hello-bindle:ok through a linked capability", async () => {
		const sink = collectEvents();
		const host = createRuntimeLocalComponentHost({
			appendEvent: sink.appendEvent,
		});
		host.registerProvider(helloBindleProvider);
		host.loadComponent({ parsed: true, ...helloBindleComponent });
		host.link({
			componentId: "hello-bindle",
			importInterface: first(
				helloBindleComponent.imports,
				"helloBindleComponent.imports",
			),
			providerId: helloBindleProvider.id,
			exportInterface: first(
				helloBindleComponent.imports,
				"helloBindleComponent.imports",
			),
		});

		const response = await host.handleHttp("hello-bindle", {
			method: "GET",
			path: "/health",
			headers: [],
			body: "",
		});

		expect(response.body).toContain("hello-bindle:ok");
		expect(sink.events.map((event) => event.type)).toEqual([
			"component.Loaded",
			"link.Established",
			"link.Called",
			"component.Invoked",
		]);
		const established = sink.events.find(
			(event) => event.type === "link.Established",
		);
		expect(established).toMatchObject({
			boundaryMode: "live",
			transport: "in-process",
		});
	});
});
