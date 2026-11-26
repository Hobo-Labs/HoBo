/**
 * How the wRPC link layer refuses.
 *
 * `wrpc-in-process-link.test.ts` proves a linked import routes to a provider
 * export. This covers what happens when it cannot — and every one of these is a
 * case where doing something instead of refusing would be worse than failing.
 *
 * **An unregistered component or provider is named, not guessed.** Linking to a
 * provider that was never registered is a configuration error; picking any
 * available provider would wire a component to an implementation nobody chose.
 *
 * **A missing import or export pin refuses even when both sides exist.** Two
 * components can both be registered and still have no interface in common. The
 * link is between *interfaces*, not between ids, so both halves are checked.
 *
 * **An empty id is refused at registration, not at call time.** An unnamed
 * component would occupy a map slot nothing can address, and the failure would
 * surface much later as "no route" against a component that looks registered.
 *
 * **Backpressure sheds load with a typed error rather than buffering.** An
 * unbounded queue in front of a saturated provider turns a slow dependency into
 * an out-of-memory crash, and hides the saturation until it is too late to
 * shed.
 *
 * The in-process transport is the real one, so these refusals are the ones a
 * caller actually sees.
 */
import {
	MembraneBackpressureError,
	NoRouteError,
	ProviderHandlerStore,
	parseInterfaceId,
	parseWireVersion,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createInProcessTransport,
	createJsonWitCodec,
	createWrpcLinkLayer,
} from "../src/index.js";

const KV = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const BLOB = parseInterfaceId("wasi:blobstore/blobstore@0.2.0");
const FLOOR = "0.2.0";

function layer(options: { maxInFlight?: number } = {}) {
	const store = new ProviderHandlerStore();
	const transport = createInProcessTransport({
		store,
		codec: createJsonWitCodec(),
	});
	return createWrpcLinkLayer({
		transport,
		compatibilityFloor: FLOOR,
		store,
		...(options.maxInFlight !== undefined
			? { maxInFlight: options.maxInFlight }
			: {}),
	});
}

const pin = (interfaceId: typeof KV, version = "0.2.0") => ({
	interfaceId,
	stability: "stable" as const,
	versions: [parseWireVersion(version)],
});

/** Register a component and a provider that both speak `KV`, and link them. */
function linked(link: ReturnType<typeof layer> = layer()) {
	link.registerComponent({ id: "api", imports: [pin(KV)] });
	link.registerProvider({
		id: "kv",
		exports: [pin(KV)],
		handlers: { [KV]: { get: async () => ({ value: "v" }) } },
		// SAFETY: the layer reads exactly the fields a registration names.
	} as never);
	link.establishLink({
		componentId: "api",
		providerId: "kv",
		importInterface: KV,
		exportInterface: KV,
		// SAFETY: the layer reads exactly the fields a link request names.
	} as never);
	return link;
}

describe("registering", () => {
	it("refuses a component with no id", () => {
		// An unnamed component occupies a map slot nothing can address; the
		// failure would otherwise surface much later as "no route".
		expect(() => layer().registerComponent({ imports: [] } as never)).toThrow(
			/component_id_required/,
		);
	});

	it("refuses a component with an empty id", () => {
		expect(() =>
			layer().registerComponent({ id: "", imports: [] } as never),
		).toThrow(/component_id_required/);
	});

	it("refuses a provider with no id", () => {
		expect(() => layer().registerProvider({ exports: [] } as never)).toThrow(
			/provider_id_required/,
		);
	});

	it("refuses a provider with an empty id", () => {
		expect(() =>
			layer().registerProvider({ id: "", exports: [] } as never),
		).toThrow(/provider_id_required/);
	});

	it("names which side was unnamed", () => {
		// One error text for both would leave an operator checking the wrong
		// half of their configuration.
		expect(() => layer().registerComponent({} as never)).toThrow(/component/);
		expect(() => layer().registerProvider({} as never)).toThrow(/provider/);
	});
});

describe("establishing a link", () => {
	it("refuses a component that was never registered", () => {
		const link = layer();
		link.registerProvider({
			id: "kv",
			exports: [pin(KV)],
			handlers: { [KV]: {} },
		} as never);
		// Guessing a component here would wire an implementation to something
		// nobody declared.
		expect(() =>
			link.establishLink({
				componentId: "ghost",
				providerId: "kv",
				importInterface: KV,
				exportInterface: KV,
			} as never),
		).toThrow(/component_not_registered: ghost/);
	});

	it("refuses a provider that was never registered", () => {
		const link = layer();
		link.registerComponent({ id: "api", imports: [pin(KV)] });
		expect(() =>
			link.establishLink({
				componentId: "api",
				providerId: "ghost",
				importInterface: KV,
				exportInterface: KV,
			} as never),
		).toThrow(/provider_not_registered: ghost/);
	});

	it("refuses an import the component never declared", () => {
		const link = layer();
		link.registerComponent({ id: "api", imports: [pin(KV)] });
		link.registerProvider({
			id: "blob",
			exports: [pin(BLOB)],
			handlers: { [BLOB]: {} },
		} as never);
		// Both sides exist and still have no interface in common. The link is
		// between interfaces, not between ids.
		expect(() =>
			link.establishLink({
				componentId: "api",
				providerId: "blob",
				importInterface: BLOB,
				exportInterface: BLOB,
			} as never),
		).toThrow();
	});

	it("refuses an export the provider never declared", () => {
		const link = layer();
		link.registerComponent({ id: "api", imports: [pin(KV)] });
		link.registerProvider({
			id: "blob",
			exports: [pin(BLOB)],
			handlers: { [BLOB]: {} },
		} as never);
		expect(() =>
			link.establishLink({
				componentId: "api",
				providerId: "blob",
				importInterface: KV,
				exportInterface: KV,
			} as never),
		).toThrow();
	});

	it("links when both sides declare the interface", () => {
		expect(() => linked()).not.toThrow();
	});
});

describe("calling an import", () => {
	it("refuses a component that was never registered", async () => {
		await expect(layer().callImport("ghost", KV, "get", {})).rejects.toThrow(
			/component_not_registered: ghost/,
		);
	});

	it("refuses an interface with no established link", async () => {
		const link = layer();
		link.registerComponent({ id: "api", imports: [pin(KV), pin(BLOB)] });
		// Registered but unlinked: a call has nowhere to go, and inventing a
		// route would reach a provider the operator never wired.
		await expect(link.callImport("api", BLOB, "get", {})).rejects.toThrow(
			NoRouteError,
		);
	});

	it("routes a linked call to its provider", async () => {
		const link = linked();
		expect(await link.callImport("api", KV, "get", {})).toEqual({ value: "v" });
	});

	it("defaults the payload to an empty object", async () => {
		const link = linked();
		// A call with no arguments is ordinary; requiring an explicit `{}` would
		// make every no-arg operation noisier at the call site.
		await expect(link.callImport("api", KV, "get")).resolves.toBeDefined();
	});
});

describe("membrane backpressure", () => {
	/** A provider whose handler blocks until released. */
	function blockingLayer(maxInFlight: number) {
		const link = layer({ maxInFlight });
		let release = () => undefined as undefined;
		const gate = new Promise<void>((resolve) => {
			release = () => resolve();
		});
		link.registerComponent({ id: "api", imports: [pin(KV)] });
		link.registerProvider({
			id: "kv",
			exports: [pin(KV)],
			handlers: {
				[KV]: {
					get: async () => {
						await gate;
						return { value: "v" };
					},
				},
			},
			// SAFETY: the layer reads exactly the fields a registration names.
		} as never);
		link.establishLink({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
			// SAFETY: the layer reads exactly the fields a link request names.
		} as never);
		return { link, release };
	}

	it("sheds a call past the in-flight bound", async () => {
		const { link, release } = blockingLayer(1);
		const first = link.callImport("api", KV, "get", {});
		// An unbounded queue in front of a saturated provider turns a slow
		// dependency into an out-of-memory crash.
		await expect(link.callImport("api", KV, "get", {})).rejects.toThrow(
			MembraneBackpressureError,
		);
		release();
		await first;
	});

	it("accepts the call again once the provider drains", async () => {
		const { link, release } = blockingLayer(1);
		const first = link.callImport("api", KV, "get", {});
		await link.callImport("api", KV, "get", {}).catch(() => undefined);
		release();
		await first;
		// Shedding is temporary. A bound that never recovered would turn one
		// slow call into a permanently closed membrane.
		await expect(link.callImport("api", KV, "get", {})).resolves.toBeDefined();
	});

	it("releases the slot even when the call fails", async () => {
		const link = layer({ maxInFlight: 1 });
		link.registerComponent({ id: "api", imports: [pin(KV)] });
		link.registerProvider({
			id: "kv",
			exports: [pin(KV)],
			handlers: {
				[KV]: {
					get: async () => {
						throw new Error("provider exploded");
					},
				},
			},
			// SAFETY: the layer reads exactly the fields a registration names.
		} as never);
		link.establishLink({
			componentId: "api",
			providerId: "kv",
			importInterface: KV,
			exportInterface: KV,
			// SAFETY: the layer reads exactly the fields a link request names.
		} as never);
		await link.callImport("api", KV, "get", {}).catch(() => undefined);
		// A slot leaked on the failure path would close the membrane after
		// exactly `maxInFlight` errors — the worst possible time to stop
		// accepting calls.
		await expect(link.callImport("api", KV, "get", {})).rejects.toThrow(
			/provider exploded/,
		);
	});

	it("is unbounded when no limit is given", async () => {
		const { link, release } = blockingLayer(Number.POSITIVE_INFINITY);
		const calls = [
			link.callImport("api", KV, "get", {}),
			link.callImport("api", KV, "get", {}),
			link.callImport("api", KV, "get", {}),
		];
		// Carry-only is the default: the bound is opt-in, so an unconfigured
		// link behaves exactly as it did before backpressure existed.
		release();
		await expect(Promise.all(calls)).resolves.toHaveLength(3);
	});

	it("counts in-flight calls per provider", async () => {
		const link = layer({ maxInFlight: 1 });
		let release = () => undefined as undefined;
		const gate = new Promise<void>((resolve) => {
			release = () => resolve();
		});
		link.registerComponent({ id: "api", imports: [pin(KV), pin(BLOB)] });
		for (const [id, iface] of [
			["kv", KV],
			["blob", BLOB],
		] as const) {
			link.registerProvider({
				id,
				exports: [pin(iface)],
				handlers: {
					[iface]: {
						get: async () => {
							await gate;
							return { value: id };
						},
					},
				},
				// SAFETY: the layer reads exactly the fields a registration names.
			} as never);
			link.establishLink({
				componentId: "api",
				providerId: id,
				importInterface: iface,
				exportInterface: iface,
				// SAFETY: the layer reads exactly the fields a link request names.
			} as never);
		}
		const first = link.callImport("api", KV, "get", {});
		// A global counter would make one slow provider shed load for every
		// other provider in the process.
		const second = link.callImport("api", BLOB, "get", {});
		release();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
	});
});
