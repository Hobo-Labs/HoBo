import {
	type ComponentHostEvent,
	type HttpResponse,
	type ParsedComponentDescriptor,
	parseInterfaceId,
} from "@hobo/core";
import { expect, it } from "vitest";
import { createRuntimeLocalComponentHost } from "../src/component-host.js";
import { ComponentHostError, ComponentTrapError } from "../src/errors.js";

const KV = parseInterfaceId("wasi:keyvalue/store@0.2.0");
const HTTP = "wasi:http/incoming-handler@0.2.0";
const component = (id: string): ParsedComponentDescriptor => ({
	parsed: true,
	id,
	imports: [KV],
	exports: {},
});
const provider = { id: "provider", exports: { [KV]: { get: () => "value" } } };

it("stops future operations after either kind of ambiguous sink failure", () => {
	for (let trial = 0; trial < 40; trial++) {
		const committed = trial % 2 === 1;
		const written: ComponentHostEvent[] = [];
		let fail = true;
		const host = createRuntimeLocalComponentHost({
			appendEvent(event) {
				if (committed || !fail) written.push(event);
				if (fail) {
					fail = false;
					throw new Error("sink response lost");
				}
			},
		});
		expect(() => host.loadComponent(component(`first-${trial}`))).toThrow(
			/event_sink_uncertain/,
		);
		expect(() => host.loadComponent(component(`second-${trial}`))).toThrow(
			/event_sink_uncertain/,
		);
		expect(host.lifecycle(`second-${trial}`).state).toBe("missing");
		expect(() => host.registerProvider(provider)).toThrow(
			/event_sink_uncertain/,
		);
		expect(written).toHaveLength(committed ? 1 : 0);
	}
});

it("fails closed when a sink returns a promise or another thenable", async () => {
	// oxlint-disable unicorn/no-thenable -- The boundary test must construct a thenable.
	// biome-ignore lint/suspicious/noThenProperty: This test deliberately constructs a thenable.
	const thenable = Object.defineProperty({}, "then", {
		value: (_resolve: () => void, reject: (error: Error) => void) =>
			reject(new Error("thenable failure")),
	});
	// oxlint-enable unicorn/no-thenable
	for (const appendEvent of [
		async () => "finished",
		async () => {
			throw new Error("async failure");
		},
		() => thenable,
	]) {
		const host = createRuntimeLocalComponentHost({ appendEvent });
		expect(() => host.loadComponent(component("first"))).toThrow(
			/event_sink_uncertain/,
		);
		expect(() => host.loadComponent(component("second"))).toThrow(
			/event_sink_uncertain/,
		);
		await Promise.resolve();
		await Promise.resolve();
	}
});

it("keeps poisoned host state unchanged across every effectful entry point", async () => {
	const host = createRuntimeLocalComponentHost({
		appendEvent: () => {
			throw new Error("sink failed");
		},
	});
	host.registerProvider(provider);
	expect(() => host.loadComponent(component("first"))).toThrow(
		/event_sink_uncertain/,
	);
	expect(() =>
		host.link({
			componentId: "first",
			importInterface: KV,
			providerId: "provider",
			exportInterface: KV,
		}),
	).toThrow(/event_sink_uncertain/);
	await expect(
		host.invokeLinkedImport("first", KV, "get"),
	).rejects.toMatchObject({ code: "event_sink_uncertain" });
	await expect(
		host.handleHttp("first", {
			method: "GET",
			path: "/",
			headers: [],
			body: "",
		}),
	).rejects.toMatchObject({ code: "event_sink_uncertain" });
	await expect(host.teardownComponent("first")).rejects.toMatchObject({
		code: "event_sink_uncertain",
	});
	expect(host.lifecycle("first").state).toBe("loaded");
	expect(host.linkTable()).toEqual([]);
});

it("refuses callback reentry without changing host state", () => {
	let failure: unknown;
	const host = createRuntimeLocalComponentHost({
		appendEvent(event) {
			if (event.type !== "component.Loaded") return;
			try {
				host.registerProvider(provider);
			} catch (error) {
				failure = error;
			}
		},
	});
	host.loadComponent(component("first"));
	expect(failure).toMatchObject({ code: "event_sink_reentrant" });
	expect(() =>
		host.link({
			componentId: "first",
			importInterface: KV,
			providerId: "provider",
			exportInterface: KV,
		}),
	).toThrow(/provider_not_registered/);
});

it("does not invoke a provider after its call event becomes uncertain", async () => {
	let calls = 0;
	const host = createRuntimeLocalComponentHost({
		appendEvent(event) {
			if (event.type === "link.Called") throw new Error("lost response");
		},
	});
	host.registerProvider({
		id: "provider",
		exports: {
			[KV]: {
				get: () => {
					calls++;
					return "value";
				},
			},
		},
	});
	host.loadComponent(component("first"));
	host.link({
		componentId: "first",
		importInterface: KV,
		providerId: "provider",
		exportInterface: KV,
	});
	await expect(
		host.invokeLinkedImport("first", KV, "get"),
	).rejects.toMatchObject({ code: "event_sink_uncertain" });
	await expect(
		host.invokeLinkedImport("first", KV, "get"),
	).rejects.toMatchObject({ code: "event_sink_uncertain" });
	expect(calls).toBe(0);
});

it("does not turn an uncertain completion event into a component trap", async () => {
	const seen: string[] = [];
	const host = createRuntimeLocalComponentHost({
		appendEvent(event) {
			seen.push(event.type);
			if (event.type === "component.Invoked") throw new Error("lost response");
		},
	});
	host.loadComponent({
		parsed: true,
		id: "http",
		imports: [],
		exports: {
			[HTTP]: { handle: () => ({ status: 204, headers: [], body: "" }) },
		},
	});
	await expect(
		host.handleHttp("http", {
			method: "GET",
			path: "/",
			headers: [],
			body: "",
		}),
	).rejects.toMatchObject({ code: "event_sink_uncertain" });
	expect(seen).toEqual(["component.Loaded", "component.Invoked"]);
});

it("records a component trap when the guest throws an error with the same code", async () => {
	const seen: string[] = [];
	const host = createRuntimeLocalComponentHost({
		appendEvent: (event) => {
			seen.push(event.type);
		},
	});
	host.loadComponent({
		parsed: true,
		id: "http",
		imports: [],
		exports: {
			[HTTP]: {
				handle: () => {
					throw new ComponentHostError("event_sink_uncertain", "guest failure");
				},
			},
		},
	});
	await expect(
		host.handleHttp("http", {
			method: "GET",
			path: "/",
			headers: [],
			body: "",
		}),
	).rejects.toBeInstanceOf(ComponentTrapError);
	expect(seen).toEqual(["component.Loaded", "component.Trapped"]);
	expect(() => host.registerProvider(provider)).not.toThrow();
});

it("refuses teardown while a linked call is in flight and allows it after completion", async () => {
	let finish: (value: string) => void = () => {};
	const pending = new Promise<string>((resolve) => {
		finish = resolve;
	});
	const host = createRuntimeLocalComponentHost({ appendEvent: () => {} });
	host.registerProvider({
		id: "provider",
		exports: { [KV]: { get: () => pending } },
	});
	host.loadComponent(component("first"));
	host.link({
		componentId: "first",
		importInterface: KV,
		providerId: "provider",
		exportInterface: KV,
	});
	const call = host.invokeLinkedImport("first", KV, "get");
	try {
		await expect(host.teardownComponent("first")).rejects.toMatchObject({
			code: "component_busy",
		});
	} finally {
		finish("done");
		await call;
	}
	await expect(host.teardownComponent("first")).resolves.toBeUndefined();
	expect(host.lifecycle("first").state).toBe("torn-down");
});

it("fences an active HTTP invocation and releases the fence after it settles", async () => {
	let finish: (value: HttpResponse) => void = () => {};
	const pending = new Promise<HttpResponse>((resolve) => {
		finish = resolve;
	});
	const host = createRuntimeLocalComponentHost({ appendEvent: () => {} });
	host.loadComponent({
		parsed: true,
		id: "http",
		imports: [],
		exports: { [HTTP]: { handle: () => pending } },
	});
	const call = host.handleHttp("http", {
		method: "GET",
		path: "/",
		headers: [],
		body: "",
	});
	try {
		await expect(host.teardownComponent("http")).rejects.toMatchObject({
			code: "component_busy",
		});
	} finally {
		finish({ status: 204, headers: [], body: "" });
		await call;
	}
	await expect(host.teardownComponent("http")).resolves.toBeUndefined();
});

it("does not append a completion event after another sink failure", async () => {
	let finish: (value: HttpResponse) => void = () => {};
	const pending = new Promise<HttpResponse>((resolve) => {
		finish = resolve;
	});
	const seen: string[] = [];
	let failNext = false;
	const host = createRuntimeLocalComponentHost({
		appendEvent(event) {
			seen.push(event.type);
			if (failNext) {
				failNext = false;
				throw new Error("sink failed");
			}
		},
	});
	host.loadComponent({
		parsed: true,
		id: "http",
		imports: [],
		exports: { [HTTP]: { handle: () => pending } },
	});
	const call = host.handleHttp("http", {
		method: "GET",
		path: "/",
		headers: [],
		body: "",
	});
	failNext = true;
	expect(() => host.loadComponent(component("other"))).toThrow(
		/event_sink_uncertain/,
	);
	finish({ status: 204, headers: [], body: "" });
	await expect(call).rejects.toMatchObject({ code: "event_sink_uncertain" });
	expect(seen).toEqual(["component.Loaded", "component.Loaded"]);
});

it("releases a linked-call fence after provider failure", async () => {
	const host = createRuntimeLocalComponentHost({ appendEvent: () => {} });
	host.registerProvider({
		id: "provider",
		exports: {
			[KV]: { get: () => Promise.reject(new Error("provider failed")) },
		},
	});
	host.loadComponent(component("first"));
	host.link({
		componentId: "first",
		importInterface: KV,
		providerId: "provider",
		exportInterface: KV,
	});
	await expect(host.invokeLinkedImport("first", KV, "get")).rejects.toThrow(
		/provider failed/,
	);
	await expect(host.teardownComponent("first")).resolves.toBeUndefined();
});
