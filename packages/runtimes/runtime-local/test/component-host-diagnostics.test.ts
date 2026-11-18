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
	// SAFETY: The concrete host exposes this method at runtime; the mutable
	// test view deliberately exercises JavaScript callers outside its readonly type.
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
