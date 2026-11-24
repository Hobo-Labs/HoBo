import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { createRivetHttpActor } from "../src/rivet-runtime.js";

const context = () => ({ name: "web", key: ["tenant"], vars: {} });
const request = () =>
	new Request("https://app.test/resource", {
		headers: { authorization: "original" },
	});

it("reauthorizes original ingress metadata after the handler, without sharing mutable headers", async () => {
	const observed: string[] = [];
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationCoverage: "admission-and-response",
		authorize: ({ request: metadata }) => {
			observed.push(metadata.headers.get("authorization") ?? "missing");
			metadata.headers.set("authorization", "authorizer mutation");
			return true;
		},
		entrypoint: () => (input: Request) => {
			input.headers.set("authorization", "handler mutation");
			return new Response("ready");
		},
	});
	const response = await binding.handle(context(), request());
	expect(await response.text()).toBe("ready");
	expect(observed).toEqual(["original", "original"]);
});

it("distinguishes a post-effect denial and retires the suppressed response", async () => {
	let authorized = true;
	let effects = 0;
	let cancelled = false;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationCoverage: "admission-and-response",
		authorize: () => authorized,
		entrypoint: () => () => {
			effects++;
			authorized = false;
			return new Response(
				new ReadableStream({
					cancel: () => {
						cancelled = true;
					},
				}),
			);
		},
	});
	const response = await binding.handle(context(), request());
	expect(response.status).toBe(403);
	expect(await response.json()).toEqual({
		error: "authorization-denied",
		execution: "possibly-completed",
	});
	await vi.waitFor(() => expect(cancelled).toBe(true));
	expect(effects).toBe(1);
});

it("reports a possibly completed effect when response authorization times out", async () => {
	let checks = 0;
	let effects = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationTimeoutMs: 100,
		authorizationCoverage: "admission-and-response",
		authorize: () => (++checks === 1 ? true : new Promise<boolean>(() => {})),
		entrypoint: () => () => {
			effects++;
			return new Response("secret");
		},
	});
	const response = await binding.handle(context(), request());
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "possibly-completed",
	});
	expect({ checks, effects }).toEqual({ checks: 2, effects: 1 });
});

it("suppresses a response when the entrypoint fence is revoked during the handler", async () => {
	let trusted = true;
	let checks = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationCoverage: "admission-and-response",
		verifyEntrypoint: () => trusted,
		authorize: () => {
			checks++;
			return true;
		},
		entrypoint: () => () => {
			trusted = false;
			return new Response("secret");
		},
	});
	const response = await binding.handle(context(), request());
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "possibly-completed",
	});
	expect(checks).toBe(1);
});

it("does not invoke an authorizer after the source scope is revoked", async () => {
	let authorizations = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationCoverage: "admission-and-response",
		verifyEntrypoint: () => false,
		authorize: () => {
			authorizations++;
			return true;
		},
		entrypoint: () => () => new Response("unexpected"),
	});
	const response = await binding.handle(context(), request());
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "not-started",
	});
	expect(authorizations).toBe(0);
});

it("does not disclose if the final verification consumes its authorization deadline", async () => {
	let completed = false;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationTimeoutMs: 100,
		authorizationCoverage: "admission-and-response",
		verifyEntrypoint: () => {
			if (completed) {
				const until = performance.now() + 120;
				while (performance.now() < until) performance.now();
			}
			return true;
		},
		authorize: () => true,
		entrypoint: () => () => {
			completed = true;
			return new Response("secret");
		},
	});
	const response = await binding.handle(context(), request());
	expect(response.status).toBe(503);
	expect(await response.json()).toEqual({
		error: "authorization-unavailable",
		execution: "possibly-completed",
	});
});

it("keeps admission-only authorization as the default", async () => {
	let checks = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorize: () => {
			checks++;
			return true;
		},
		entrypoint: () => () => new Response("ready"),
	});
	expect(await (await binding.handle(context(), request())).text()).toBe(
		"ready",
	);
	expect(checks).toBe(1);
});

it("does not execute the application after an admission denial", async () => {
	let checks = 0;
	let effects = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationCoverage: "admission-and-response",
		authorize: () => {
			checks++;
			return false;
		},
		entrypoint: () => () => {
			effects++;
			return new Response();
		},
	});
	const response = await binding.handle(context(), request());
	expect(response.status).toBe(403);
	expect({ checks, effects }).toEqual({ checks: 1, effects: 0 });
});

it("rejects invalid authorization coverage before accepting requests", () => {
	expect(() =>
		createRivetHttpActor({
			actorName: "web",
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: exercise invalid input from an untyped caller.
			authorizationCoverage: "unknown" as never,
			authorize: () => true,
			entrypoint: () => () => new Response(),
		}),
	).toThrow(TypeError);
});

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply -- SAFETY: this test deliberately delays a native header iterator at the authorization boundary. */
it("does not start authorization if copying its metadata exhausts the deadline", async () => {
	const iterator = Object.getOwnPropertyDescriptor(
		Headers.prototype,
		Symbol.iterator,
	);
	if (iterator === undefined || typeof iterator.value !== "function")
		throw new Error("native Headers iterator missing");
	const nativeIterator = iterator.value;
	let armed = false;
	let delayed = false;
	let calls = 0;
	const binding = createRivetHttpActor({
		actorName: "web",
		authorizationTimeoutMs: 30,
		verifyEntrypoint: () => {
			armed = true;
			return true;
		},
		authorize: () => {
			calls++;
			return true;
		},
		entrypoint: () => () => new Response("unexpected"),
	});
	const input = request();
	let response: Response;
	try {
		Object.defineProperty(Headers.prototype, Symbol.iterator, {
			...iterator,
			value(this: Headers) {
				if (armed && !delayed) {
					delayed = true;
					const until = performance.now() + 50;
					while (performance.now() < until) performance.now();
				}
				return Reflect.apply(nativeIterator, this, []);
			},
		});
		response = await binding.handle(context(), input);
	} finally {
		Object.defineProperty(Headers.prototype, Symbol.iterator, iterator);
	}
	expect(delayed).toBe(true);
	expect(response.status).toBe(503);
	expect(await response.json()).toMatchObject({
		error: "authorization-unavailable",
		execution: "not-started",
	});
	expect(calls).toBe(0);
});
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-reflect-apply */
