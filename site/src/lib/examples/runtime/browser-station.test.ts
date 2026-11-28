import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { readFile } from "node:fs/promises";

import {
	BrowserStationRequestSchema,
	BrowserStationResponseSchema,
} from "../../../_generated/browser_station_pb.js";

import {
	browserWitRuntimeAvailable,
	buildBrowserWitStationHtml,
	parseBrowserRuntimeManifest,
} from "./browser-station.js";
import {
	buildBrowserStationGuestSource,
	type BrowserStationInvokeRequest,
	type BrowserStationInvokeResponse,
} from "./guest-source.js";
import type { JsonValue } from "../../json-inspect.js";

type GuestModule = {
	invoke(request: BrowserStationInvokeRequest): BrowserStationInvokeResponse;
};

const counterRuntime = {
	schemaVersion: "hobo.try-runtime/v1" as const,
	resources: {
		counter: { kind: "kv" as const, initial: { count: 0 } },
	},
	routes: [
		{
			method: "GET" as const,
			path: "/api/count",
			action: "read" as const,
			resource: "counter",
			key: "count",
		},
		{
			method: "POST" as const,
			path: "/api/count",
			action: "increment" as const,
			resource: "counter",
			key: "count",
		},
	],
};

function manifest(
	overrides: { readonly [key: string]: JsonValue | undefined } = {},
) {
	// SAFETY: test fixture is a JSON manifest with field overrides at this boundary.
	return parseBrowserRuntimeManifest({
		schemaVersion: "hobo.browser-wit-runtime/v1",
		entryModule: "station.js",
		componentDigest: `sha256:${"a".repeat(64)}`,
		sourceDigest: `sha256:${"d".repeat(64)}`,
		buildDigest: `sha256:${"e".repeat(64)}`,
		witWorld: "hobo:try/browser-station@0.1.0",
		toolchain: { jco: "1.24.3", componentizeJs: "0.21.0", esbuild: "0.25.0" },
		assets: ["station.js", "station.component.wasm"],
		assetDigests: {
			"station.js": `sha256:${"b".repeat(64)}`,
			"station.component.wasm": `sha256:${"a".repeat(64)}`,
		},
		...overrides,
	} as JsonValue);
}

describe("browser WIT Environment Station", () => {
	it("derives executable guest behavior from the example runtime descriptor", async () => {
		const source = buildBrowserStationGuestSource([
			{ id: "hello-counter", runtime: counterRuntime },
		]);
		// SAFETY: data-URL guest module exports invoke() from the generated source.
		const guest = (await import(
			`data:text/javascript,${encodeURIComponent(source)}`
		)) as GuestModule;

		const response = guest.invoke({
						exampleId: "hello-counter",
						stationId: "station:browser:test",
						method: "POST",
						path: "/api/count",
						bodyJson: JSON.stringify({ by: 2 }),
					});
		expect({ status: response.status, body: JSON.parse(response.bodyJson) }).toEqual({
			status: 200,
			body: { count: 2 },
		});
	});

	it(
		"implements greet from hello-world handlers.txt guest handlers",
		async () => {
		const { loadExamplesCatalog } = await import("../catalog.js");
		const catalog = await loadExamplesCatalog();
		const hello = catalog.find(({ id }) => id === "hello-world")!;
		expect(hello.handlersSource).toContain("Hello World!");
		expect(hello.source).toContain("b.web()");
		expect(hello.source).not.toContain("@trainable");
		expect(hello.source).not.toContain("handlers.txt");
		const source = buildBrowserStationGuestSource([
			{
				id: hello.id,
				runtime: hello.runtime,
				handlersSource: hello.handlersSource,
			},
		]);
		// SAFETY: data-URL guest module exports invoke() from the generated source.
		const guest = (await import(
			`data:text/javascript,${encodeURIComponent(source)}`
		)) as GuestModule;
		const invoke = (body: JsonValue) => {
			const response = guest.invoke({
				exampleId: "hello-world",
				stationId: "station:browser:test",
				method: "POST",
				path: "/api/greet",
				bodyJson: JSON.stringify(body),
			});
			return { status: response.status, body: JSON.parse(response.bodyJson) };
		};
		expect(invoke({})).toEqual({ status: 200, body: { greeting: "Hello World!" } });
		expect(invoke({ name: "Bo" })).toEqual({
			status: 200,
			body: { greeting: "Hello, Bo!" },
		});
		},
		30_000,
	);

	it(
		"implements todo-api list/create/toggle via kv-backed built-in guest actions",
		async () => {
		const { loadExamplesCatalog } = await import("../catalog.js");
		const catalog = await loadExamplesCatalog();
		const todos = catalog.find(({ id }) => id === "todo-api")!;
		expect(todos.source).toContain("@trainable");
		expect(todos.handlersSource).toBe("");
		const source = buildBrowserStationGuestSource([
			{
				id: todos.id,
				runtime: todos.runtime,
				handlersSource: todos.handlersSource,
			},
		]);
		// SAFETY: data-URL guest module exports invoke() from the generated source.
		const guest = (await import(
			`data:text/javascript,${encodeURIComponent(source)}`
		)) as GuestModule;
		const invoke = (method: string, path: string, body?: JsonValue) => {
			const response = guest.invoke({
				exampleId: "todo-api",
				stationId: "station:browser:test",
				method,
				path,
				bodyJson: JSON.stringify(body ?? {}),
			});
			return { status: response.status, body: JSON.parse(response.bodyJson) };
		};
		expect(invoke("POST", "/api/todos", { text: "ship it", completed: false })).toEqual({
			status: 201,
			body: { id: "1", text: "ship it", completed: false },
		});
		expect(invoke("GET", "/api/todos")).toEqual({
			status: 200,
			body: { items: [{ id: "1", text: "ship it", completed: false }] },
		});
		expect(invoke("PATCH", "/api/todos/:id", { id: "1" })).toEqual({
			status: 200,
			body: { id: "1", text: "ship it", completed: true },
		});
		},
		30_000,
	);

	it(
		"does not embed OpenSaaS in the browser WIT guest (local-bridge deploy)",
		async () => {
		const { loadExamplesCatalog } = await import("../catalog.js");
		const catalog = await loadExamplesCatalog();
		const saas = catalog.find(({ id }) => id === "opensaas");
		expect(saas?.deployKind).toBe("local-bridge");
		expect(saas?.handlersSource).toBe("");
		const source = buildBrowserStationGuestSource(
			catalog.filter((example) => (example.handlersSource ?? "").trim().length > 0),
		);
		expect(source).not.toContain('"opensaas"');
		},
		30_000,
	);

	it("executes the declared notes delete route", async () => {
		const source = buildBrowserStationGuestSource([
			{
				id: "kv-notes",
				runtime: {
					schemaVersion: "hobo.try-runtime/v1",
					resources: { notes: { kind: "kv", initial: [] } },
					routes: [
						{ method: "POST", path: "/api/notes", action: "create", resource: "notes" },
						{ method: "DELETE", path: "/api/notes/:id", action: "delete", resource: "notes" },
						{ method: "GET", path: "/api/notes", action: "list", resource: "notes" },
					],
				},
			},
		]);
		// SAFETY: data-URL guest module exports invoke() from the generated source.
		const guest = (await import(
			`data:text/javascript,${encodeURIComponent(source)}`
		)) as GuestModule;
		const invoke = (method: string, path: string, body?: JsonValue) =>
			((response) => ({ status: response.status, body: JSON.parse(response.bodyJson) }))(
				guest.invoke({
					exampleId: "kv-notes",
					stationId: "station:browser:test",
					method,
					path,
					bodyJson: JSON.stringify(body ?? {}),
				}),
			);

		const created = invoke("POST", "/api/notes", { id: "spoofed", text: "ship it" });
		expect(created).toEqual({ status: 201, body: { id: "1", text: "ship it" } });
		expect(invoke("DELETE", "/api/notes/:id", { id: "1" })).toEqual({
			status: 200,
			body: { id: "1", text: "ship it" },
		});
		expect(invoke("GET", "/api/notes")).toEqual({
			status: 200,
			body: { items: [] },
		});
	});

	it("reconciles generated protobuf, CUE, and WIT request/response views", async () => {
		const request = create(BrowserStationRequestSchema, {
			exampleId: "hello-counter",
			stationId: "station:browser:test",
			method: "POST",
			path: "/api/count",
			bodyJson: JSON.stringify({ by: 1 }),
		});
		const response = create(BrowserStationResponseSchema, {
			status: 200,
			bodyJson: JSON.stringify({ count: 1 }),
		});
		const [wit, proto, cue] = await Promise.all([
			readFile(new URL("../../../../../examples/browser-runtime/wit/station.wit", import.meta.url), "utf8"),
			readFile(new URL("../../../../data-models/browser_station.proto", import.meta.url), "utf8"),
			readFile(new URL("../../../../data-models/browser_station.cue", import.meta.url), "utf8"),
		]);

		expect(request).toMatchObject({ exampleId: "hello-counter", bodyJson: '{"by":1}' });
		expect(response).toMatchObject({ status: 200, bodyJson: '{"count":1}' });
		expect(wit).toContain("export invoke: func(request: invoke-request) -> invoke-response");
		expect(proto).toContain("message BrowserStationRequest");
		expect(cue).toContain("#BrowserStationRequest");
	});

	it("instantiates the component inside the blob host and reports lifecycle only", () => {
		const runtimeManifest = manifest({
			assets: ["station.js", "station.core.wasm", "station.component.wasm"],
			assetDigests: {
				"station.js": `sha256:${"b".repeat(64)}`,
				"station.core.wasm": `sha256:${"c".repeat(64)}`,
				"station.component.wasm": `sha256:${"a".repeat(64)}`,
			},
		});
		const html = buildBrowserWitStationHtml({
			exampleId: "hello-counter",
			title: "Hello Counter",
			ui: "counter",
			stationId: "station:browser:test",
			targetLabel: "Browser WASM",
			entryModuleSource: "export const $init = Promise.resolve(); export function invoke() {}",
			wasmAssets: [{ name: "station.core.wasm", base64: "AGFzbQAAAAA=" }],
			manifest: runtimeManifest,
			runtime: counterRuntime,
		});

		expect(html).toContain("new Blob([moduleSource]");
		expect(html).toContain("URL.createObjectURL");
		expect(html).toContain("await component.$init");
		expect(html).toContain("component.invoke");
		expect(html).toContain('await call("read", undefined, true)');
		expect(html).toContain('status: "ready"');
		expect(html).not.toContain("parent.invoke");
		expect(html).not.toContain("claim token");
	});

	it("exposes the notes delete route as a user action", () => {
		const html = buildBrowserWitStationHtml({
			exampleId: "kv-notes",
			title: "KV Notes",
			ui: "notes",
			stationId: "station:browser:test",
			targetLabel: "Browser WASM",
			entryModuleSource: "export const $init = Promise.resolve(); export function invoke() {}",
			wasmAssets: [],
			manifest: manifest(),
			runtime: {
				schemaVersion: "hobo.try-runtime/v1",
				resources: { notes: { kind: "kv", initial: [] } },
				routes: [
					{ method: "POST", path: "/api/notes", action: "create", resource: "notes" },
					{ method: "DELETE", path: "/api/notes/:id", action: "delete", resource: "notes" },
					{ method: "GET", path: "/api/notes", action: "list", resource: "notes" },
				],
			},
		});

		expect(html).toContain('button("Delete first", "delete"');
	});

	it("exposes hello and saas host UI mounts", () => {
		const helloHtml = buildBrowserWitStationHtml({
			exampleId: "hello-world",
			title: "Hello World",
			ui: "hello",
			stationId: "station:browser:test",
			targetLabel: "Browser WASM",
			entryModuleSource: "export const $init = Promise.resolve(); export function invoke() {}",
			wasmAssets: [],
			manifest: manifest(),
			runtime: {
				schemaVersion: "hobo.try-runtime/v1",
				resources: {},
				routes: [{ method: "POST", path: "/api/greet", action: "greet" }],
			},
		});
		expect(helloHtml).toContain('button("Greet", "greet"');

		const saasHtml = buildBrowserWitStationHtml({
			exampleId: "opensaas",
			title: "OpenSaaS Kit",
			ui: "saas",
			stationId: "station:browser:test",
			targetLabel: "Browser WASM",
			entryModuleSource: "export const $init = Promise.resolve(); export function invoke() {}",
			wasmAssets: [],
			manifest: manifest(),
			runtime: {
				schemaVersion: "hobo.try-runtime/v1",
				resources: {
					users: { kind: "kv", initial: [] },
					session: { kind: "kv", initial: null },
					products: { kind: "kv", initial: [] },
					orders: { kind: "kv", initial: [] },
				},
				routes: [
					{ method: "POST", path: "/api/auth/login", action: "login" },
					{ method: "GET", path: "/api/products", action: "listProducts" },
				],
			},
		});
		expect(saasHtml).toContain("mountSaasUi");
		expect(saasHtml).toContain("Admin");
	});

	it("fails closed on a synthetic or malformed runtime manifest", () => {
		expect(() =>
			manifest({ componentDigest: "synthetic" }),
		).toThrow(/provenance/);
		expect(() =>
			manifest({ assetDigests: undefined }),
		).toThrow(/assetDigests/);
		expect(() =>
			manifest({ assets: ["station.js", "station.js", "station.component.wasm"] }),
		).toThrow(/assets/);
		expect(() =>
			manifest({
				assetDigests: {
					"station.js": `sha256:${"b".repeat(64)}`,
					"station.component.wasm": `sha256:${"c".repeat(64)}`,
					extra: `sha256:${"d".repeat(64)}`,
				},
			}),
		).toThrow(/assetDigests/);
	});
});

describe("browserWitRuntimeAvailable", () => {
	it("is false when the Pages host 404s the manifest", async () => {
		// SAFETY: fetch double returns a 404 Response for the missing manifest.
		const fetchImpl = (async () => new Response("missing", { status: 404 })) as typeof fetch;
		await expect(
			browserWitRuntimeAvailable("https://example.test/HoBo/examples/runtime", fetchImpl),
		).resolves.toBe(false);
	});

	it("is true when the manifest is published", async () => {
		// SAFETY: fetch double returns a published manifest Response.
		const fetchImpl = (async () => new Response("{}", { status: 200 })) as typeof fetch;
		await expect(
			browserWitRuntimeAvailable("/HoBo/examples/runtime", fetchImpl),
		).resolves.toBe(true);
	});
});
