import { describe, expect, it } from "vitest";
import { bindle } from "../src/bindle.js";
import { env } from "../src/env.js";
import type { JsonObject } from "../src/json.js";
import { CATALOG_ROWS } from "../src/types.js";

describe("bindle()", () => {
	it("builds a graph with at least two resources and one dependsOn edge", () => {
		const definition = bindle("shop", (b) => {
			const store = b.data();
			const orders = b.queue();
			const api = b.api().dependsOn(store, orders);
			return { store, orders, api };
		});

		expect(Object.isFrozen(definition)).toBe(true);
		expect(definition.name).toBe("shop");
		expect(Object.keys(definition.resources)).toEqual([
			"store",
			"orders",
			"api",
		]);
		expect(definition.resources.store).toEqual({
			kind: "data",
			name: "store",
			stableId: "data:store",
			declaredAllow: [],
			annotations: [],
			dependsOn: [],
		});
		expect(definition.edges).toEqual([
			{ from: "api", to: "store" },
			{ from: "api", to: "orders" },
		]);
		expect(JSON.parse(JSON.stringify(definition))).toEqual({
			name: "shop",
			requirements: {
				labels: {},
				prefer: [],
				require: ["data", "http", "queue"],
				runtimes: ["wasm"],
			},
			resources: {
				store: {
					kind: "data",
					name: "store",
					stableId: "data:store",
					declaredAllow: [],
					annotations: [],
					dependsOn: [],
				},
				orders: {
					kind: "queue",
					name: "orders",
					stableId: "queue:orders",
					declaredAllow: [],
					annotations: [],
					dependsOn: [],
				},
				api: {
					kind: "api",
					name: "api",
					stableId: "api:api",
					declaredAllow: [],
					annotations: [
						{
							provider: "hobo",
							option: "session-replay",
							config: { enabled: true, defaultSupply: "kit-local-on" },
						},
					],
					dependsOn: ["data", "queue"],
				},
			},
			edges: [
				{ from: "api", to: "store" },
				{ from: "api", to: "orders" },
			],
		});
	});

	it("records allow narrowing; rejects cloud provider annotations", () => {
		const definition = bindle("annotated", (b) => ({
			todos: b.kv().allow("get", "set"),
			api: b.api(),
		}));
		expect(definition.resources.todos.declaredAllow).toEqual(["get", "set"]);

		expect(() =>
			bindle("bad", (b) => ({
				api: b.api().with({
					provider: "aws",
					option: "fargate",
					config: { cpu: 512 },
				}),
			})),
		).toThrow(/bindle-provider-selection-forbidden/);
	});

	it("env() is injectable camp config attached with .with", () => {
		const campEnv = env({ GREETING_PREFIX: "howdy", APP_TITLE: "howdy" });
		const definition = bindle("hello", (b) => {
			const api = b.api().with(campEnv);
			const web = b.web().with(campEnv).dependsOn(api);
			return { api, web };
		});

		expect(campEnv).toEqual({
			provider: "hobo",
			option: "env",
			config: { GREETING_PREFIX: "howdy", APP_TITLE: "howdy" },
		});
		// Every App Kit (api + web) carries default Session Replay (ADR-0137).
		expect(definition.resources.api.annotations).toEqual([
			{
				provider: "hobo",
				option: "session-replay",
				config: { enabled: true, defaultSupply: "kit-local-on" },
			},
			campEnv,
		]);
		expect(definition.resources.web.annotations).toEqual([
			{
				provider: "hobo",
				option: "session-replay",
				config: { enabled: true, defaultSupply: "kit-local-on" },
			},
			campEnv,
		]);
	});

	it("every App Kit auto-enables session-replay; explicit false opts out; kv does not", () => {
		const definition = bindle("replay-demo", (b) => {
			const api = b.api();
			const web = b.web();
			const service = b.service();
			const kv = b.kv();
			const off = b.web().with({
				provider: "hobo",
				option: "session-replay",
				config: { enabled: false },
			});
			return { api, web, service, kv, off };
		});
		for (const name of ["api", "web", "service"] as const) {
			expect(
				definition.resources[name].annotations.some(
					(a) => a.option === "session-replay" && a.config.enabled === true,
				),
				name,
			).toBe(true);
		}
		expect(
			definition.resources.kv.annotations.some(
				(a) => a.option === "session-replay",
			),
		).toBe(false);
		expect(
			definition.resources.off.annotations.some(
				(a) => a.option === "session-replay" && a.config.enabled === false,
			),
		).toBe(true);
		expect(
			definition.resources.off.annotations.filter(
				(a) => a.option === "session-replay",
			),
		).toHaveLength(1);
	});

	it("external / container / wasmComponent declare deps with required runtimes", async () => {
		const { collectRequiredRuntimes } = await import("../src/dependencies.js");
		const definition = bindle("deps-demo", (b) => {
			const legacy = b.external({
				connectionString: "Host=legacy;Db=app",
			});
			const redis = b.container({
				image: "redis:7",
				endpoints: { http: { port: 6379 } },
			});
			const plugin = b.wasmComponent({
				source: "./deps/plugin.wasm",
			});
			const api = b.api().withReference(legacy, redis, plugin);
			return { legacy, redis, plugin, api };
		});

		expect(definition.resources.legacy?.kind).toBe("external");
		expect(definition.resources.redis?.kind).toBe("container");
		expect(definition.resources.plugin?.kind).toBe("wasm-component");
		expect(definition.edges).toEqual(
			expect.arrayContaining([
				{ from: "api", to: "legacy" },
				{ from: "api", to: "redis" },
				{ from: "api", to: "plugin" },
			]),
		);
		expect(collectRequiredRuntimes(definition)).toEqual(["oci", "wasm"]);
	});

	it("exposes a builder method for every catalog factory", () => {
		// Catalog factory names are kebab-case; builder keys are camelCase
		// (only "wasm-component" -> wasmComponent differs today).
		const builderKeyFor = (factory: string): string =>
			factory.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
		bindle("catalog-coverage", (b) => {
			// SAFETY: assertion required at this I/O or test boundary.
			const builder = b as JsonObject;
			for (const row of CATALOG_ROWS) {
				expect(
					builder[builderKeyFor(row.factory)] instanceof Function,
					row.factory,
				).toBe(true);
			}
			return {};
		});
	});

	it("b.schedule() lands in the definition with empty declaredAllow", () => {
		const definition = bindle("cron", (b) => ({
			nightly: b.schedule(),
		}));
		expect(definition.resources.nightly.kind).toBe("schedule");
		expect(definition.resources.nightly.stableId).toBe("schedule:nightly");
		expect(definition.resources.nightly.declaredAllow).toEqual([]);
		// schedule is an infra kind — no default App Kit session-replay.
		expect(definition.resources.nightly.annotations).toEqual([]);
	});

	it("allow() narrows verbs on the new verb-bearing builder kinds", () => {
		const definition = bindle("flags", (b) => ({
			beta: b.flag().allow("eval", "change"),
			deploy: b.rollout().allow("start", "promote"),
		}));
		expect(definition.resources.beta.kind).toBe("flag");
		expect(definition.resources.beta.declaredAllow).toEqual(["eval", "change"]);
		expect(definition.resources.deploy.declaredAllow).toEqual([
			"start",
			"promote",
		]);
	});

	it("rejects empty resource names", () => {
		expect(() =>
			bindle("shop", (b) => ({
				"": b.kv(),
			})),
		).toThrow(/bindle resource names must be non-empty strings/);
	});
});

describe("declared components (Plan 2 Syntax 0)", () => {
	const METADATA_SYMBOL =
		// SAFETY: assertion required at this I/O or test boundary.
		(Symbol as { metadata?: symbol }).metadata ?? Symbol.for("Symbol.metadata");
	const COMPONENT_METADATA = Symbol.for("hobo.component.metadata");

	function declaredComponentClass(): new () => object {
		let constructed = 0;
		class Storefront {
			readonly instance: number;
			constructor() {
				constructed += 1;
				this.instance = constructed;
			}
		}
		Object.defineProperty(Storefront, METADATA_SYMBOL, {
			value: {
				[COMPONENT_METADATA]: {
					intent: "Public storefront API.",
					name: "Storefront",
					operations: ["storefront.rankFeed"],
				},
			},
		});
		return Storefront;
	}

	it("b.api accepts a @component-decorated class as its binding", () => {
		const Storefront = declaredComponentClass();
		const definition = bindle("shop", (b) => ({
			api: b.api(Storefront),
		}));

		const entry = definition.entrypoint("api");
		expect(entry instanceof Function).toBe(true);
		// The stored handler instantiates the component (DI registration).
		// SAFETY: assertion required at this I/O or test boundary.
		const instance = entry?.() as { instance: number };
		expect(instance.instance).toBe(1);
		// The manifest stays pure data — no component leakage.
		expect(Object.keys(definition.resources.api).includes("handler")).toBe(
			false,
		);
	});

	it("b.service and b.web accept bindings too; plain thunks still work", () => {
		const Storefront = declaredComponentClass();
		const thunk = () => "handler";
		const definition = bindle("shop", (b) => ({
			svc: b.service(Storefront),
			web: b.web(thunk),
		}));
		expect(definition.entrypoint("svc") instanceof Function).toBe(true);
		expect(definition.entrypoint("web")?.()).toBe("handler");
	});

	it("undecorated classes pass through as plain handlers (no instantiation)", () => {
		class NotAComponent {}
		const definition = bindle("shop", (b) => ({
			// SAFETY: assertion required at this I/O or test boundary.
			api: b.api(NotAComponent as BindleEntrypoint),
		}));
		// Stored verbatim: calling it without `new` is the caller's concern.
		expect(definition.entrypoint("api")).toBe(NotAComponent);
	});

	it("accepts nameless bindle((b) => …) and infers requirements from kinds", () => {
		const definition = bindle((b) => {
			const web = b.web();
			return { web };
		});
		expect(definition.name).toBe("app");
		expect(definition.requirements.require).toEqual(["http"]);
		expect(definition.requirements.runtimes).toEqual(["wasm"]);
	});

	it("infers http/container + oci from b.service() + b.container() with no requirements block", () => {
		const nameless = bindle((b) => {
			const db = b.container({ image: "postgres:16-alpine" });
			const web = b.service().dependsOn(db);
			return { db, web };
		});
		expect(nameless.requirements.require).toEqual(["container", "http"]);
		expect(nameless.requirements.runtimes).toEqual(["oci"]);

		const named = bindle("opensaas", (b) => {
			const db = b.container({ image: "postgres:16-alpine" });
			const web = b.service().dependsOn(db);
			return { db, web };
		});
		expect(named.requirements.require).toEqual(["container", "http"]);
		expect(named.requirements.runtimes).toEqual(["oci"]);
	});

	it("instantiates @trainable classes bound to b.web", () => {
		const METADATA_SYMBOL =
			// SAFETY: assertion required at this I/O or test boundary.
			(Symbol as { metadata?: symbol }).metadata ??
			Symbol.for("Symbol.metadata");
		const TRAINABLE_METADATA = Symbol.for("hobo.trainable.metadata");
		class Hello {
			greet(name?: string): string {
				return name?.trim() ? `Hello, ${name.trim()}!` : "Hello World!";
			}
		}
		Object.defineProperty(Hello, METADATA_SYMBOL, {
			value: { [TRAINABLE_METADATA]: ["Hello.greet"] },
		});
		const definition = bindle((b) => ({
			web: b.web(Hello),
		}));
		// SAFETY: assertion required at this I/O or test boundary.
		const instance = definition.entrypoint("web")?.() as Hello;
		expect(instance).toBeInstanceOf(Hello);
		expect(instance.greet("Bo")).toBe("Hello, Bo!");
		expect(definition.requirements.require).toContain("http");
	});
});
