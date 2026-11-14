import { collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { afterEach, describe, expect, it } from "vitest";

import { app as api } from "../src/api.js";
import definition from "../src/bindle.js";
import { app as web } from "../src/webapp.js";

const API = "services__api__http__0";

afterEach(() => {
	delete process.env[API];
	delete process.env.GREETING_PREFIX;
	delete process.env.APP_TITLE;
});

/** Camp env injected by `env({ … })` on both resources (not a placement pin). */
const injectedEnv = {
	provider: "hobo",
	option: "env",
	config: { GREETING_PREFIX: "howdy", APP_TITLE: "howdy" },
} as const;

/** Default Session Replay annotation auto-attached to every App Kit (ADR-0137). */
const sessionReplayDefault = {
	provider: "hobo",
	option: "session-replay",
	config: { enabled: true, defaultSupply: "kit-local-on" },
} as const;

/**
 * Default-state authoring graph from `bindle()` — what the example constructs
 * before collection / plan / serve.
 */
const DEFAULT_DEFINITION = {
	name: "hello-bindle",
	resources: {
		api: {
			kind: "api",
			name: "api",
			stableId: "api:api",
			declaredAllow: [],
			annotations: [sessionReplayDefault, injectedEnv],
			dependsOn: [],
		},
		web: {
			kind: "web",
			name: "web",
			stableId: "web:web",
			declaredAllow: [],
			annotations: [sessionReplayDefault, injectedEnv],
			// dependsOn stores dependency *kinds* (api resource kind is "api").
			dependsOn: ["api"],
		},
	},
	edges: [{ from: "web", to: "api" }],
} as const;

/**
 * Provider-agnostic manifest IR from run-to-collect (`hobo collect`).
 * Component→component edges (web→api) stay on the definition graph; they are
 * not wiring binds. Camp env annotations are injected at serve time, not
 * baked into this IR.
 */
const DEFAULT_MANIFEST = {
	schema: "hobo.manifest/v1",
	componentHost: {
		kind: "wasmtime",
		version: "46.0.1",
	},
	resources: {
		api: {
			type: "component.v1",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			links: [],
			env: {},
			bindings: {},
		},
		web: {
			type: "component.v1",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
			links: [],
			env: {},
			bindings: {},
			bind: ["api"],
		},
	},
} as const;

/** Canonical hash of DEFAULT_MANIFEST — fails if the default IR drifts. */
const DEFAULT_MANIFEST_HASH =
	"sha256:e9472d81fa38b4bd9e25aafc869e061d3fb25395494bdc6bc0048845a8a4e189";

describe("hello-bindle", () => {
	it("constructs the default bindle definition (authoring graph)", () => {
		// Full snapshot so devs can read exactly what bindle() builds.
		expect({
			name: definition.name,
			resources: definition.resources,
			edges: definition.edges,
		}).toEqual(DEFAULT_DEFINITION);
	});

	it("collects the default hobo.manifest/v1 IR (what plan/up read)", () => {
		const first = collectBindleManifest(targetFromBindleDefinition(definition));
		const second = collectBindleManifest(
			targetFromBindleDefinition(definition),
		);

		expect(first.bindleId).toBe("hello-bindle");
		expect(first.resources).toEqual(["api", "web"]);
		// No backing-data binds: only two HTTP components + app-level edge.
		expect(first.binds).toEqual([]);
		expect(first.manifest.value).toEqual(DEFAULT_MANIFEST);
		expect(first.manifestHash).toBe(DEFAULT_MANIFEST_HASH);

		// Deterministic: same source → same IR + hash every run.
		expect(second.manifestHash).toBe(first.manifestHash);
		expect(second.manifest).toEqual(first.manifest);
	});

	it("api greets with default prefix when env is unset", async () => {
		const res = await api.request("/hello?name=World");
		expect(await res.json()).toEqual({
			message: "hello, World",
			greetingPrefix: "hello",
		});
	});

	it("api respects GREETING_PREFIX when set", async () => {
		process.env.GREETING_PREFIX = "hi";
		const res = await api.request("/hello?name=X");
		expect(await res.json()).toEqual({
			message: "hi, X",
			greetingPrefix: "hi",
		});
	});

	it("web calls api via services__api__http__0 and uses APP_TITLE", async () => {
		process.env[API] = "http://api.test/";
		process.env.APP_TITLE = "howdy";
		const original = globalThis.fetch;
		globalThis.fetch = async (input) => {
			expect(String(input)).toBe("http://api.test/hello?name=bindle");
			return Response.json({
				message: "howdy, bindle",
				greetingPrefix: "howdy",
			});
		};
		try {
			const html = await (await web.request("/?name=bindle")).text();
			expect(html).toContain('data-testid="app-title">howdy</h1>');
			expect(html).toContain('data-testid="greeting">howdy, bindle</p>');
		} finally {
			globalThis.fetch = original;
		}
	});

	it("bindle entrypoints resolve through @hobo/adapter-hono", async () => {
		// SAFETY: assertion to `ntrypoint("api")?.() as typeof api.fetch; const bo` is required at this boundary.
		const handler = definition.entrypoint("api")?.() as typeof api.fetch;
		const body = await (
			await handler(new Request("http://local/hello?name=A"))
		).json();
		expect(body).toEqual({ message: "hello, A", greetingPrefix: "hello" });
	});
});
