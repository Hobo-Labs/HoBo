/**
 * How the component host refuses a link it cannot honour.
 *
 * `component-host.test.ts` proves the happy path: a component loads, links to
 * a provider, and its imports route. This covers every way that can fail —
 * and each refusal here shares one property, which is the reason they are
 * worth pinning together.
 *
 * **Nothing is ever guessed.** A link names four things: a component, an
 * import interface, a provider, and an export interface. If any one of them is
 * absent, the host refuses by name rather than picking a plausible substitute.
 * Guessing a provider would wire a component to an implementation nobody
 * chose; guessing an operation would call something the caller did not ask
 * for. Both produce a system that runs and is wrong, which is strictly worse
 * than one that will not start.
 *
 * **Each refusal names which of the four was missing.** One shared
 * "link failed" would leave an operator checking four separate pieces of
 * configuration to find out which one they got wrong.
 *
 * **Refusing does not damage the host.** A rejected link, a missing operation,
 * and a component that traps all leave the host able to serve everything else.
 * A host that a single bad component could take down would make one tenant's
 * bug everyone's outage.
 *
 * Teardown gets the same treatment from the other side: it must remove the
 * routes *into* a component, because a route surviving its target is a call
 * that reaches a torn-down instance.
 */
import type { ComponentHostEvent, InterfaceId } from "@hobo/core";
import { parseInterfaceId } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	ComponentHostError,
	createInProcessWasmtimeEngine,
	createRuntimeLocalComponentHost,
} from "../src/index.js";

const KV = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const BLOB = parseInterfaceId("wasi:blobstore/blobstore@0.2.0");
const HTTP = parseInterfaceId("wasi:http/incoming-handler@0.2.0");

function hostForTest() {
	const events: ComponentHostEvent[] = [];
	const host = createRuntimeLocalComponentHost({
		engine: createInProcessWasmtimeEngine({ version: "wasmtime@46.0.1" }),
		appendEvent: (event: ComponentHostEvent) => {
			events.push(event);
		},
		// SAFETY: the host reads exactly the fields this factory names.
	} as never);
	return { host, events };
}

/** Load a component declaring `imports`, with the given exports and leases. */
function loaded(
	host: ReturnType<typeof hostForTest>["host"],
	options: {
		id?: string;
		imports?: readonly InterfaceId[];
		exports?: Record<string, unknown>;
		leases?: readonly string[];
	} = {},
) {
	return host.loadComponent({
		id: options.id ?? "api",
		imports: [...(options.imports ?? [KV])],
		exports: options.exports ?? {},
		...(options.leases !== undefined ? { leases: [...options.leases] } : {}),
		// SAFETY: the host reads exactly the fields a descriptor names.
	} as never);
}

/** Register a provider exporting `iface` with the given operations. */
function provide(
	host: ReturnType<typeof hostForTest>["host"],
	iface: InterfaceId,
	operations: Record<string, unknown> = { get: async () => ({ value: "v" }) },
	id = "kv",
) {
	host.registerProvider({
		id,
		exports: { [iface]: operations },
		// SAFETY: the host reads exactly the fields a descriptor names.
	} as never);
}

const linkOf = (overrides: Record<string, unknown> = {}) => ({
	componentId: "api",
	importInterface: KV,
	providerId: "kv",
	exportInterface: KV,
	...overrides,
});

describe("the engine a host is built on", () => {
	it("refuses an engine that is not wasmtime", () => {
		// The host's whole isolation story is the wasmtime boundary. Accepting
		// another engine would leave every later guarantee unfounded, and the
		// place to find that out is construction rather than first invocation.
		expect(() =>
			createRuntimeLocalComponentHost({
				engine: { kind: "v8", version: "0", instantiate: () => ({}) },
				appendEvent: () => undefined,
			} as never),
		).toThrow(/engine_required/);
	});
});

describe("linking", () => {
	it("refuses a component that was never loaded", () => {
		// Loading is what produces an instance; linking to an id nobody loaded
		// would register a route to nothing.
		const { host } = hostForTest();
		provide(host, KV);
		expect(() => host.link(linkOf({ componentId: "ghost" }))).toThrow(
			ComponentHostError,
		);
	});

	it("refuses a provider that was never registered", () => {
		// Picking any available provider would wire a component to an
		// implementation nobody chose.
		const { host } = hostForTest();
		loaded(host);
		expect(() => host.link(linkOf({ providerId: "ghost" }))).toThrow(
			/provider_not_registered: ghost/,
		);
	});

	it("refuses an import the component never declared", () => {
		// A component's imports are its declared needs. Routing an undeclared
		// one would hand it a capability it never asked for — the opposite of
		// the capability model.
		const { host } = hostForTest();
		loaded(host, { imports: [KV] });
		provide(host, BLOB, { get: async () => ({}) }, "blob");
		expect(() =>
			host.link(
				linkOf({
					providerId: "blob",
					importInterface: BLOB,
					exportInterface: BLOB,
				}),
			),
		).toThrow(/import_not_declared/);
	});

	it("names the component and interface in that refusal", () => {
		const { host } = hostForTest();
		loaded(host, { imports: [KV] });
		provide(host, BLOB, { get: async () => ({}) }, "blob");
		expect(() =>
			host.link(
				linkOf({
					providerId: "blob",
					importInterface: BLOB,
					exportInterface: BLOB,
				}),
			),
		).toThrow(/api:wasi:blobstore/);
	});

	it("refuses an export the provider does not offer", () => {
		// Both halves are checked. Two components can both exist and still
		// share no interface, and the link is between interfaces, not ids.
		const { host } = hostForTest();
		loaded(host, { imports: [KV, BLOB] });
		provide(host, KV);
		expect(() => host.link(linkOf({ exportInterface: BLOB }))).toThrow(
			/export_not_found: kv:wasi:blobstore/,
		);
	});

	it("links when all four names resolve", () => {
		const { host } = hostForTest();
		loaded(host);
		provide(host, KV);
		expect(host.link(linkOf())).toMatchObject({
			componentId: "api",
			providerId: "kv",
			transport: "in-process",
		});
	});

	it("leaves the host usable after a refused link", () => {
		// A host a single bad configuration could wedge would make one
		// tenant's mistake everyone's outage.
		const { host } = hostForTest();
		loaded(host);
		provide(host, KV);
		expect(() => host.link(linkOf({ providerId: "ghost" }))).toThrow();
		expect(() => host.link(linkOf())).not.toThrow();
	});

	it("records nothing on the event log for a refused link", () => {
		// The log is the record of what the host actually did. A
		// `link.Established` for a link that was refused would make the log
		// disagree with the link table.
		const { host, events } = hostForTest();
		loaded(host);
		provide(host, KV);
		const before = events.length;
		expect(() => host.link(linkOf({ providerId: "ghost" }))).toThrow();
		expect(events).toHaveLength(before);
	});
});

describe("invoking a linked import", () => {
	it("refuses an interface with no route", async () => {
		const { host } = hostForTest();
		loaded(host, { imports: [KV, BLOB] });
		await expect(
			host.invokeLinkedImport("api", BLOB, "get", {}),
		).rejects.toThrow(/no_route/);
	});

	it("refuses an operation the provider does not export", async () => {
		// Calling a neighbouring operation because the name nearly matched
		// would run something the caller did not ask for.
		const { host } = hostForTest();
		loaded(host);
		provide(host, KV, { get: async () => ({ value: "v" }) });
		host.link(linkOf());
		await expect(
			host.invokeLinkedImport("api", KV, "delete", {}),
		).rejects.toThrow(/operation_not_found: .*delete/);
	});

	it("refuses an export entry that is not callable", async () => {
		// A config-shaped value where a function belongs. Refusing here is
		// clearer than a TypeError from calling a string.
		const { host } = hostForTest();
		loaded(host);
		provide(host, KV, { get: "not a function" });
		host.link(linkOf());
		await expect(host.invokeLinkedImport("api", KV, "get", {})).rejects.toThrow(
			/operation_not_found/,
		);
	});

	it("defaults an omitted payload to null", async () => {
		// A no-argument call is ordinary; requiring an explicit payload would
		// make every such operation noisier at the call site. Null rather than
		// undefined, because the payload crosses a JSON boundary.
		const { host } = hostForTest();
		loaded(host);
		provide(host, KV, { get: async (payload: unknown) => ({ payload }) });
		host.link(linkOf());
		expect(await host.invokeLinkedImport("api", KV, "get")).toStrictEqual({
			payload: null,
		});
	});

	it("routes the call to the linked provider", async () => {
		const { host } = hostForTest();
		loaded(host);
		provide(host, KV);
		host.link(linkOf());
		expect(await host.invokeLinkedImport("api", KV, "get", {})).toStrictEqual({
			value: "v",
		});
	});
});

describe("serving HTTP", () => {
	it("refuses a component with no incoming handler", async () => {
		// Not every component serves HTTP. Refusing by name beats a TypeError
		// on an undefined handler halfway through a request.
		const { host } = hostForTest();
		loaded(host);
		await expect(
			host.handleHttp("api", { method: "GET", path: "/" } as never),
		).rejects.toThrow(/http_handler_missing: api/);
	});

	it("refuses a handler entry that is not callable", async () => {
		const { host } = hostForTest();
		loaded(host, { exports: { [HTTP]: { handle: "not a function" } } });
		await expect(
			host.handleHttp("api", { method: "GET", path: "/" } as never),
		).rejects.toThrow(/http_handler_missing/);
	});

	it("refuses a component that was never loaded", async () => {
		const { host } = hostForTest();
		await expect(
			host.handleHttp("ghost", { method: "GET", path: "/" } as never),
		).rejects.toThrow(ComponentHostError);
	});
});

describe("tearing down", () => {
	it("removes the routes into the component", async () => {
		// A route surviving its target is a call that reaches a torn-down
		// instance — the failure teardown exists to prevent.
		const { host } = hostForTest();
		loaded(host);
		provide(host, KV);
		host.link(linkOf());
		await host.teardownComponent("api");
		expect(host.linkTable()).toStrictEqual([]);
	});

	it("releases the component's leases", async () => {
		// Leases are held capabilities. One left behind is a capability nobody
		// can release, because the component that held it is gone.
		const { host } = hostForTest();
		loaded(host, { leases: ["lease-a"] });
		expect(host.activeLeases()).toStrictEqual(["lease-a"]);
		await host.teardownComponent("api");
		expect(host.activeLeases()).toStrictEqual([]);
	});

	it("leaves another component's routes alone", async () => {
		// Route keys are prefixed by component id; a prefix match that was too
		// loose would tear down a neighbour sharing a name prefix.
		const { host } = hostForTest();
		loaded(host, { id: "api" });
		loaded(host, { id: "api-worker" });
		provide(host, KV);
		host.link(linkOf());
		host.link(linkOf({ componentId: "api-worker" }));
		await host.teardownComponent("api");
		expect(host.linkTable()).toHaveLength(1);
	});

	it("marks the component torn down rather than forgetting it", async () => {
		// A torn-down component is a different answer from one that never
		// existed: an operator asking about it deserves to be told it ran.
		const { host } = hostForTest();
		loaded(host);
		await host.teardownComponent("api");
		expect(host.lifecycle("api")).toStrictEqual({
			id: "api",
			state: "torn-down",
		});
	});

	it("refuses to tear down a component that was never loaded", async () => {
		const { host } = hostForTest();
		await expect(host.teardownComponent("ghost")).rejects.toThrow(
			ComponentHostError,
		);
	});

	it("reports a never-loaded component as missing", () => {
		expect(hostForTest().host.lifecycle("ghost")).toStrictEqual({
			id: "ghost",
			state: "missing",
		});
	});

	it("refuses an invocation after teardown", async () => {
		const { host } = hostForTest();
		loaded(host);
		provide(host, KV);
		host.link(linkOf());
		await host.teardownComponent("api");
		await expect(host.invokeLinkedImport("api", KV, "get", {})).rejects.toThrow(
			ComponentHostError,
		);
	});
});

describe("leases", () => {
	it("defaults to none when a component declares none", () => {
		// Absent leases are no leases, not an error — most components hold
		// none, and requiring an empty array would be noise in every manifest.
		const { host } = hostForTest();
		loaded(host);
		expect(host.activeLeases()).toStrictEqual([]);
	});

	it("collects leases across components", () => {
		const { host } = hostForTest();
		loaded(host, { id: "api", leases: ["lease-a"] });
		loaded(host, { id: "worker", leases: ["lease-b"] });
		expect(host.activeLeases().sort()).toStrictEqual(["lease-a", "lease-b"]);
	});
});
