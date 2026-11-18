import type { ComponentHostEvent, ParsedComponentDescriptor } from "@hobo/core";
import { expect, it } from "vitest";
import { createRuntimeLocalComponentHost } from "../src/component-host.js";
import { createInProcessWasmtimeEngine } from "../src/engine/wasmtime.js";

function descriptor(
	id: string,
	leases: string[] = [],
): ParsedComponentDescriptor {
	return { parsed: true, id, imports: [], exports: {}, leases };
}

it("refuses duplicate loads without replacing the current component or leases", async () => {
	let seed = 614620;
	for (let trial = 0; trial < 60; trial++) {
		seed = (seed * 48_271) % 2_147_483_647;
		const number = seed;
		const id = `component-${number}`;
		const lease = `lease-${number}`;
		const events: ComponentHostEvent[] = [];
		const delegate = createInProcessWasmtimeEngine();
		let instantiations = 0;
		const host = createRuntimeLocalComponentHost({
			engine: {
				...delegate,
				instantiate(input) {
					instantiations++;
					return delegate.instantiate(input);
				},
			},
			appendEvent: (event) => {
				events.push(event);
			},
		});
		host.loadComponent(descriptor(id, [lease]));
		expect(() => host.loadComponent(descriptor(id, ["replacement"]))).toThrow(
			/component_already_loaded/,
		);
		expect(instantiations).toBe(1);
		expect(host.activeLeases()).toEqual([lease]);
		expect(host.lifecycle(id).state).toBe("loaded");
		expect(events.map((event) => event.type)).toEqual(["component.Loaded"]);
		await host.teardownComponent(id);
		expect(host.activeLeases()).toEqual([]);
		host.loadComponent(descriptor(id, ["replacement"]));
		expect(instantiations).toBe(2);
		expect(host.activeLeases()).toEqual(["replacement"]);
	}
});

it("refuses a reentrant load while the first instance is being created", () => {
	const delegate = createInProcessWasmtimeEngine();
	let nestedFailure: unknown;
	let entered = false;
	const host = createRuntimeLocalComponentHost({
		engine: {
			...delegate,
			instantiate(input) {
				if (!entered) {
					entered = true;
					try {
						host.loadComponent(descriptor(input.id, ["nested"]));
					} catch (error) {
						nestedFailure = error;
					}
				}
				return delegate.instantiate(input);
			},
		},
		appendEvent: () => {},
	});
	host.loadComponent(descriptor("reentrant", ["outer"]));
	expect(nestedFailure).toMatchObject({ code: "component_already_loaded" });
	expect(host.activeLeases()).toEqual(["outer"]);
});

it("releases the loading claim when instantiation fails", () => {
	const delegate = createInProcessWasmtimeEngine();
	let fail = true;
	const host = createRuntimeLocalComponentHost({
		engine: {
			...delegate,
			instantiate(input) {
				if (fail) {
					fail = false;
					throw new Error("instantiate failed");
				}
				return delegate.instantiate(input);
			},
		},
		appendEvent: () => {},
	});
	expect(() => host.loadComponent(descriptor("retry"))).toThrow(
		/instantiate failed/,
	);
	expect(host.lifecycle("retry").state).toBe("missing");
	expect(() => host.loadComponent(descriptor("retry"))).not.toThrow();
});

it("refuses an engine result for a different component identity", () => {
	const delegate = createInProcessWasmtimeEngine();
	const events: ComponentHostEvent[] = [];
	let mismatched = true;
	const host = createRuntimeLocalComponentHost({
		engine: {
			...delegate,
			instantiate: (input) => {
				const instance = delegate.instantiate(input);
				if (mismatched) {
					mismatched = false;
					return { ...instance, id: "other" };
				}
				return instance;
			},
		},
		appendEvent: (event) => {
			events.push(event);
		},
	});
	expect(() => host.loadComponent(descriptor("requested"))).toThrow(
		/component_identity_mismatch/,
	);
	expect(host.lifecycle("requested").state).toBe("missing");
	expect(host.activeLeases()).toEqual([]);
	expect(events).toHaveLength(0);
	expect(() => host.loadComponent(descriptor("requested"))).not.toThrow();
});

it("keeps the requested leases when an engine changes the descriptor", () => {
	const delegate = createInProcessWasmtimeEngine();
	const host = createRuntimeLocalComponentHost({
		engine: {
			...delegate,
			instantiate(input) {
				input.leases?.push("changed");
				return delegate.instantiate(input);
			},
		},
		appendEvent: () => {},
	});
	host.loadComponent(descriptor("captured", ["original"]));
	expect(host.activeLeases()).toEqual(["original"]);
});
