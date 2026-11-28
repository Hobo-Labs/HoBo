import type {
	ComponentHostEvent,
	ComponentHostPort,
	ParsedComponentDescriptor,
} from "@hobo/core";
import { expect, it } from "vitest";
import { createRuntimeLocalComponentHost } from "../src/component-host.js";

const component = (id: string): ParsedComponentDescriptor => ({
	parsed: true,
	id,
	imports: [],
	exports: {},
});

function readMirror(host: ComponentHostPort): ComponentHostEvent[] {
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: The concrete host exposes this method at runtime; the mutable test view deliberately exercises JavaScript callers outside its readonly type.
	return (
		host as ComponentHostPort & { eventMirror(): ComponentHostEvent[] }
	).eventMirror();
}

it("returns detached lifecycle records throughout a component's lifetime", async () => {
	for (let trial = 0; trial < 40; trial++) {
		const id = `component-${trial}`;
		const host = createRuntimeLocalComponentHost({
			appendEvent: () => undefined,
		});
		host.loadComponent(component(id));
		const loaded = host.lifecycle(id);
		loaded.id = "edited";
		loaded.state = "torn-down";
		expect(host.lifecycle(id)).toEqual({ id, state: "loaded" });
		await host.teardownComponent(id);
		const tornDown = host.lifecycle(id);
		tornDown.id = "edited-again";
		tornDown.state = "loaded";
		expect(host.lifecycle(id)).toEqual({ id, state: "torn-down" });
	}
});

it("keeps the event mirror independent from sink mutations", () => {
	for (let trial = 0; trial < 40; trial++) {
		const id = `component-${trial}`;
		const captured: ComponentHostEvent[] = [];
		const host = createRuntimeLocalComponentHost({
			appendEvent(event) {
				captured.push(event);
				event.componentId = "edited-in-sink";
			},
		});
		host.loadComponent(component(id));
		expect(readMirror(host)).toEqual([
			{ type: "component.Loaded", componentId: id, engine: "wasmtime" },
		]);
		Object.assign(captured[0], { componentId: "edited-later" });
		expect(readMirror(host)).toEqual([
			{ type: "component.Loaded", componentId: id, engine: "wasmtime" },
		]);
	}
});

it("returns detached event arrays and records", async () => {
	const host = createRuntimeLocalComponentHost({
		appendEvent: () => undefined,
	});
	host.loadComponent(component("component"));
	const snapshot = readMirror(host);
	const record = snapshot[0];
	if (!record) throw new Error("event mirror is empty");
	record.componentId = "edited";
	snapshot.length = 0;
	expect(readMirror(host)).toEqual([
		{ type: "component.Loaded", componentId: "component", engine: "wasmtime" },
	]);
	await host.teardownComponent("component");
	expect(snapshot).toEqual([]);
	expect(readMirror(host)).toEqual([
		{ type: "component.Loaded", componentId: "component", engine: "wasmtime" },
		{ type: "component.TornDown", componentId: "component" },
	]);
});

it("preserves diagnostics across generated edit and teardown sequences", async () => {
	let seed = 0x45312a7b;
	const next = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed >>> 16;
	};
	for (let trial = 0; trial < 60; trial++) {
		const id = `component-${trial}-${next()}`;
		const sinkEvents: ComponentHostEvent[] = [];
		const expectedEvents: ComponentHostEvent[] = [
			{ type: "component.Loaded", componentId: id, engine: "wasmtime" },
		];
		const host = createRuntimeLocalComponentHost({
			appendEvent(event) {
				sinkEvents.push(event);
				if (next() % 2 === 0) event.componentId = "sink-edit";
			},
		});
		let expectedState: "loaded" | "torn-down" = "loaded";
		host.loadComponent(component(id));
		for (let step = 0; step < 24; step++) {
			switch (next() % 5) {
				case 0: {
					const lifecycle = host.lifecycle(id);
					lifecycle.id = "client-edit";
					lifecycle.state = next() % 2 === 0 ? "loaded" : "torn-down";
					break;
				}
				case 1:
					for (const event of sinkEvents) event.componentId = "later-sink-edit";
					break;
				case 2: {
					const snapshot = readMirror(host);
					for (const event of snapshot) event.componentId = "client-edit";
					snapshot.length = 0;
					break;
				}
				case 3:
					if (expectedState === "loaded") {
						await host.teardownComponent(id);
						expectedState = "torn-down";
						expectedEvents.push({
							type: "component.TornDown",
							componentId: id,
						});
					}
					break;
				case 4:
					readMirror(host).push({
						type: "component.TornDown",
						componentId: "client-added",
					});
					break;
			}
			expect(host.lifecycle(id)).toEqual({ id, state: expectedState });
			expect(readMirror(host)).toEqual(expectedEvents);
		}
	}
});
