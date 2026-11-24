import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { createRivetHttpActor } from "../src/rivet-runtime.js";

const context = () => ({ name: "web", key: ["tenant"], vars: {} });
const request = () => new Request("https://app.test/");

it("refuses before initialization and can recover without caching a refusal", async () => {
	let trusted = false;
	let factories = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		verifyEntrypoint: () => trusted,
		entrypoint: () => {
			factories++;
			return () => new Response("ready");
		},
	});
	const actor = context();
	const denied = await binding.handle(actor, request());
	expect(await denied.json()).toEqual({
		error: "authorization-unavailable",
		execution: "not-started",
	});
	expect(factories).toBe(0);
	trusted = true;
	expect(await (await binding.handle(actor, request())).text()).toBe("ready");
	expect(factories).toBe(1);
});

it("reports a possibly completed initialization if its source fence changes", async () => {
	let trusted = true;
	let factories = 0;
	let handlers = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		verifyEntrypoint: () => trusted,
		entrypoint: () => {
			factories++;
			trusted = false;
			return () => {
				handlers++;
				return new Response("unexpected");
			};
		},
	});
	const response = await binding.handle(context(), request());
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "possibly-completed",
	});
	expect({ factories, handlers }).toEqual({ factories: 1, handlers: 0 });
});

it("checks the fence again before invoking a cached application", async () => {
	let trusted = true;
	let handlers = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		verifyEntrypoint: () => trusted,
		entrypoint: () => () => {
			handlers++;
			return new Response("ready");
		},
	});
	const actor = context();
	expect((await binding.handle(actor, request())).status).toBe(200);
	trusted = false;
	const response = await binding.handle(actor, request());
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "not-started",
	});
	expect(handlers).toBe(1);
});

it("rechecks after an application fetch getter changes the fence", async () => {
	let trusted = true;
	let handlers = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		verifyEntrypoint: () => trusted,
		entrypoint: () => ({
			get fetch() {
				trusted = false;
				return () => {
					handlers++;
					return new Response("unexpected");
				};
			},
		}),
	});
	const response = await binding.handle(context(), request());
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "possibly-completed",
	});
	expect(handlers).toBe(0);
});

it("does not start the application when the fence check consumes the authorization deadline", async () => {
	let factories = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationTimeoutMs: 5,
		authorize: () => true,
		verifyEntrypoint: () => {
			const until = performance.now() + 15;
			while (performance.now() < until) performance.now();
			return true;
		},
		entrypoint: () => {
			factories++;
			return () => new Response();
		},
	});
	const response = await binding.handle(context(), request());
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "not-started",
	});
	expect(factories).toBe(0);
});

it("rejects asynchronous source verifiers and observes rejected native promises", async () => {
	let factories = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => true,
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: exercise an untyped host returning the wrong callback type.
		verifyEntrypoint: () => Promise.reject(new Error("unavailable")) as never,
		entrypoint: () => {
			factories++;
			return () => new Response();
		},
	});
	const response = await binding.handle(context(), request());
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "not-started",
	});
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(factories).toBe(0);
});
