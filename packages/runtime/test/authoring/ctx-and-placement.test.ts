/**
 * The capability membrane (`ctx`), actor placement resolution, and the typed
 * authoring errors.
 *
 * `createRuntimeContext` is the deny-by-default boundary described in
 * sdk-api.md §Layer 4: durability primitives always pass through, but reaching
 * another actor, minting a broker token, or invoking an agent tool works only
 * when the handler's own definition declared it. The failure mode that matters
 * is not a crash — it is a *silent grant*: a membrane that let an undeclared
 * reach through would give a handler an effect nobody audited, and the
 * capability set in the definition would become documentation rather than a
 * control.
 *
 * Placement resolution has the mirror-image property: an explicit pin must fail
 * closed. Falling back to the native host when a Camp asked for Dapr would run
 * the workload on a placement its operator did not choose, and nothing about
 * the run would say so.
 */
import { describe, expect, it } from "vitest";

import {
	type Capability,
	type CtxEffects,
	createRuntimeContext,
	tokenCapability,
	toolCapability,
} from "../../src/ctx.js";
import {
	CapabilityDeniedError,
	FatalError,
	RetryableError,
	RuntimeAuthoringError,
	WorkflowFailure,
} from "../../src/errors.js";
import { resolveActorPlacement, signalActor } from "../../src/placement.js";
import type { ActorHost } from "../../src/ports.js";

const DURABLE: CtxEffects = {
	step: async (_name, fn) => fn(),
	sleep: async () => {},
	emit: async () => 1,
	now: () => "2026-08-08T00:00:00.000Z",
	random: () => 0.5,
};

function contextWith(
	capabilities: Capability[],
	effects: Partial<CtxEffects> = {},
) {
	return createRuntimeContext({
		capabilities,
		effects: { ...DURABLE, ...effects },
	});
}

function hostNamed(name: string): ActorHost {
	return { name } as unknown as ActorHost;
}

describe("capability namespacing helpers", () => {
	it("namespaces tool and token capabilities", () => {
		// The namespace is what stops `tool:deploy` and `token:deploy` from being
		// the same grant. A flat namespace would let a handler granted one tool
		// mint a broker token for a same-named provider.
		expect(toolCapability("search")).toBe("tool:search");
		expect(tokenCapability("aws")).toBe("token:aws");
		expect(toolCapability("aws")).not.toBe(tokenCapability("aws"));
	});
});

describe("createRuntimeContext durability primitives", () => {
	it("passes step, sleep, emit, now and random through ungated", () => {
		// Deliberately ungated: these are the durability substrate, not effects.
		// Requiring a capability for `step` would make every handler declare a
		// grant that conveys nothing.
		const ctx = contextWith([]);
		expect(ctx.now()).toBe("2026-08-08T00:00:00.000Z");
		expect(ctx.random()).toBe(0.5);
		return Promise.all([
			expect(ctx.step("s", () => 7)).resolves.toBe(7),
			expect(ctx.sleep(1)).resolves.toBeUndefined(),
			expect(ctx.emit("e")).resolves.toBe(1),
		]);
	});

	it("delegates to the injected effect rather than reimplementing it", () => {
		// The engine owns journalling; the context is a membrane, not a runtime.
		// A context that implemented `step` itself would produce a step the
		// replay journal never saw.
		const seen: string[] = [];
		const ctx = contextWith([], {
			step: async (name, fn) => {
				seen.push(name);
				return fn();
			},
		});
		return ctx
			.step("charge", () => "ok")
			.then((value) => {
				expect(value).toBe("ok");
				expect(seen).toEqual(["charge"]);
			});
	});

	it("freezes the context and exposes the granted set", () => {
		// Frozen because the capability set is the audit record. A handler that
		// could add to `ctx.capabilities` at runtime would grant itself effects
		// after the definition was reviewed.
		const ctx = contextWith(["actor"]);
		expect(Object.isFrozen(ctx)).toBe(true);
		expect([...ctx.capabilities]).toEqual(["actor"]);
	});

	it("copies the capability iterable rather than aliasing it", () => {
		// `new Set(input.capabilities)`. Aliasing a caller's mutable array would
		// let the grant widen after the context was built.
		const granted = ["actor"];
		const ctx = contextWith(granted);
		granted.push("tool:anything");
		expect(ctx.capabilities.has("tool:anything")).toBe(false);
	});

	it("deduplicates a repeated grant", () => {
		expect([...contextWith(["actor", "actor"]).capabilities]).toEqual([
			"actor",
		]);
	});
});

describe("requireCapability", () => {
	it("passes for a declared capability and throws for an undeclared one", () => {
		const ctx = contextWith(["actor"]);
		expect(() => ctx.requireCapability("actor")).not.toThrow();
		expect(() => ctx.requireCapability("tool:x")).toThrow(
			CapabilityDeniedError,
		);
	});

	it("names the denied capability and the whole granted set", () => {
		// Both halves are actionable: the denied name says what to add, and the
		// granted list says what the handler *did* declare — which is usually
		// where the typo is.
		try {
			contextWith(["actor", "token:aws"]).requireCapability("tool:search");
			expect.unreachable("an undeclared capability must be denied");
		} catch (error) {
			const denied = error as CapabilityDeniedError;
			expect(denied.capability).toBe("tool:search");
			expect(denied.granted).toEqual(["actor", "token:aws"]);
			expect(denied.message).toContain("tool:search");
			expect(denied.message).toContain("actor, token:aws");
		}
	});

	it("is an exact match, never a prefix match", () => {
		// `tool:deploy-prod` must not be satisfied by a grant of `tool:deploy`.
		// A prefix or `startsWith` check here would be a privilege escalation
		// that looks like a convenience.
		const ctx = contextWith(["tool:deploy"]);
		expect(() => ctx.requireCapability("tool:deploy-prod")).toThrow(
			CapabilityDeniedError,
		);
		expect(() => ctx.requireCapability("tool")).toThrow(CapabilityDeniedError);
	});
});

describe("ctx.actor", () => {
	const stub = { key: "k", signal: async () => 1, state: async () => ({}) };

	it("delegates once the actor capability is declared", () => {
		const ctx = contextWith(["actor"], { actor: () => stub });
		expect(ctx.actor({ typeName: "Cart", key: "k" })).toBe(stub);
	});

	it("denies an undeclared reach", () => {
		// The silent-grant case this membrane exists to prevent: a handler that
		// never declared `actor` must not be able to signal another grain.
		const ctx = contextWith([], { actor: () => stub });
		expect(() => ctx.actor({ typeName: "Cart", key: "k" })).toThrow(
			CapabilityDeniedError,
		);
	});

	it("denies when granted but the engine wired no implementation", () => {
		// A declared-but-unwired capability throws rather than returning
		// undefined. Returning undefined would surface three frames later as
		// "cannot read property signal of undefined", pointing at the handler
		// rather than at the engine wiring.
		const ctx = contextWith(["actor"]);
		expect(() => ctx.actor({ typeName: "Cart", key: "k" })).toThrow(
			CapabilityDeniedError,
		);
	});
});

describe("ctx.token", () => {
	const handle = { token: "t" } as never;

	it("requires the capability for the specific provider", () => {
		// Per-provider, not a blanket `token`. A handler granted an AWS token
		// must not be able to mint one for GCP.
		const ctx = contextWith(["token:aws"], { token: () => handle });
		expect(ctx.token({ provider: "aws" } as never)).toBe(handle);
		expect(() => ctx.token({ provider: "gcp" } as never)).toThrow(
			CapabilityDeniedError,
		);
	});

	it("names the provider-scoped capability in the denial", () => {
		try {
			contextWith([], { token: () => handle }).token({
				provider: "gcp",
			} as never);
			expect.unreachable("an undeclared provider must be denied");
		} catch (error) {
			expect((error as CapabilityDeniedError).capability).toBe("token:gcp");
		}
	});

	it("denies when granted but unwired", () => {
		const ctx = contextWith(["token:aws"]);
		expect(() => ctx.token({ provider: "aws" } as never)).toThrow(
			CapabilityDeniedError,
		);
	});
});

describe("ctx.tool", () => {
	it("requires the capability for the specific tool", async () => {
		const ctx = contextWith(["tool:search"], {
			tool: async (name) => `ran ${name}`,
		});
		await expect(ctx.tool("search", {})).resolves.toBe("ran search");
		await expect(ctx.tool("deploy", {})).rejects.toThrow(CapabilityDeniedError);
	});

	it("passes the input through to the injected effect", () => {
		const seen: unknown[] = [];
		const ctx = contextWith(["tool:search"], {
			tool: async (_name, input) => {
				seen.push(input);
				return null;
			},
		});
		return ctx.tool("search", { q: "hobo" }).then(() => {
			expect(seen).toEqual([{ q: "hobo" }]);
		});
	});

	it("rejects rather than throwing synchronously when denied", async () => {
		// `tool` is async, so a caller awaits it. A synchronous throw would
		// escape a `.catch()` and land somewhere the handler did not expect.
		const ctx = contextWith([]);
		await expect(ctx.tool("search", {})).rejects.toThrow(CapabilityDeniedError);
	});

	it("denies when granted but unwired", async () => {
		await expect(
			contextWith(["tool:search"]).tool("search", {}),
		).rejects.toThrow(CapabilityDeniedError);
	});
});

describe("typed authoring errors", () => {
	it("all descend from RuntimeAuthoringError with their own name and code", () => {
		// One typed error channel, so replay and the membrane observe the same
		// hierarchy. A bare `Error` from a handler would be indistinguishable
		// from an engine bug.
		const errors = [
			new CapabilityDeniedError("tool:x", []),
			new FatalError("stop"),
			new RetryableError("again"),
			new WorkflowFailure("failed", { step: "charge" }),
		];
		for (const error of errors) {
			expect(error).toBeInstanceOf(RuntimeAuthoringError);
			expect(error).toBeInstanceOf(Error);
			expect(error.name).not.toBe("RuntimeAuthoringError");
		}
		expect(errors.map((error) => error.code)).toEqual([
			"capability.denied",
			"fatal",
			"retryable",
			"workflow.failed",
		]);
	});

	it("RetryableError carries an optional retry budget", () => {
		// Undefined means "use the step's own budget", which is different from
		// zero. A `?? 0` here would turn every unbudgeted retryable into a
		// non-retryable.
		expect(new RetryableError("again").retries).toBeUndefined();
		expect(new RetryableError("again", { retries: 3 }).retries).toBe(3);
		expect(new RetryableError("again", { retries: 0 }).retries).toBe(0);
	});

	it("WorkflowFailure names the step and keeps the cause", () => {
		// The cause is the original failure; the step is where it happened. A
		// failure record with neither is unactionable in a durable run's history.
		const cause = new Error("timeout");
		const failure = new WorkflowFailure("failed", { step: "charge", cause });
		expect(failure.step).toBe("charge");
		expect(failure.cause).toBe(cause);
		const stepless = new WorkflowFailure("failed", {});
		expect(stepless.step).toBeUndefined();
		expect(stepless.cause).toBeUndefined();
	});

	it("CapabilityDeniedError copies the granted list", () => {
		// A live reference would let the error's record of what was granted
		// change after the fact — the one thing an audit trail must not do.
		const granted = ["actor"];
		const error = new CapabilityDeniedError("tool:x", granted);
		granted.push("tool:x");
		expect(error.granted).toEqual(["actor"]);
	});

	it("renders an empty granted set readably", () => {
		expect(new CapabilityDeniedError("tool:x", []).message).toContain("[]");
	});
});

describe("resolveActorPlacement", () => {
	const nativeHost = hostNamed("native");
	const daprHost = hostNamed("dapr");
	const rivetHost = hostNamed("rivet");
	const celldHost = hostNamed("celld");

	it("defaults to native when nothing asks otherwise (ADR-0031)", () => {
		const resolved = resolveActorPlacement({ nativeHost });
		expect(resolved.mode).toBe("native");
		expect(resolved.host).toBe(nativeHost);
		// The source is part of the answer: "native because nobody asked" and
		// "native because someone pinned it" are different facts for an operator
		// debugging where their actors ended up.
		expect(resolved.source).toBe("default");
	});

	it("honours an explicit pin for each mode", () => {
		for (const [explicit, host] of [
			["native", nativeHost],
			["dapr", daprHost],
			["rivet", rivetHost],
			["celld", celldHost],
		] as const) {
			const resolved = resolveActorPlacement({
				explicit,
				nativeHost,
				daprHost,
				rivetHost,
				celldHost,
			});
			expect(resolved.mode).toBe(explicit);
			expect(resolved.host).toBe(host);
			expect(resolved.source).toBe("explicit");
		}
	});

	it("fails closed when an explicit pin has no matching host", () => {
		// The important direction. Falling back to native would run the workload
		// on a placement its operator did not choose, and the run would look
		// entirely normal.
		for (const explicit of ["dapr", "rivet", "celld"] as const) {
			expect(() => resolveActorPlacement({ explicit, nativeHost })).toThrow(
				new RegExp(`'${explicit}' requires a`, "u"),
			);
		}
	});

	it("refuses an unparseable explicit mode", () => {
		// Parsed through `@hobo/core`, so an unknown string is refused rather
		// than falling through to the native branch — which is what the `if`
		// chain would otherwise do.
		expect(() =>
			resolveActorPlacement({ explicit: "kubernetes", nativeHost }),
		).toThrow();
		expect(() => resolveActorPlacement({ explicit: 7, nativeHost })).toThrow();
	});

	it("treats an explicit undefined as absent rather than as a pin", () => {
		// `!== undefined`, so omitting the field falls through to the Camp
		// requirements rather than being parsed as a mode.
		expect(
			resolveActorPlacement({ explicit: undefined, nativeHost }).source,
		).toBe("default");
	});

	it("reads a Camp runtime requirement in each accepted spelling", () => {
		for (const requirement of ["dapr", "runtime-dapr", "dapr:v1.13"]) {
			const resolved = resolveActorPlacement({
				campRuntimeRequirements: [requirement],
				nativeHost,
				daprHost,
			});
			expect(resolved.mode).toBe("dapr");
			expect(resolved.source).toBe("camp-runtime");
		}
	});

	it("reads rivet and celld requirements the same way", () => {
		expect(
			resolveActorPlacement({
				campRuntimeRequirements: ["runtime-rivet"],
				nativeHost,
				rivetHost,
			}).mode,
		).toBe("rivet");
		expect(
			resolveActorPlacement({
				campRuntimeRequirements: ["celld:v2"],
				nativeHost,
				celldHost,
			}).mode,
		).toBe("celld");
	});

	it("checks celld before rivet before dapr when a Camp asks for several", () => {
		// A fixed precedence, so a Camp listing more than one gets a
		// deterministic answer rather than one that depends on array order.
		const resolved = resolveActorPlacement({
			campRuntimeRequirements: ["dapr", "rivet", "celld"],
			nativeHost,
			daprHost,
			rivetHost,
			celldHost,
		});
		expect(resolved.mode).toBe("celld");
	});

	it("fails closed when a Camp requirement has no matching host", () => {
		for (const [requirement, pattern] of [
			["celld", /celld but no celld ActorHost/u],
			["rivet", /rivet but no Rivet ActorHost/u],
			["dapr", /dapr but no Dapr ActorHost/u],
		] as const) {
			expect(() =>
				resolveActorPlacement({
					campRuntimeRequirements: [requirement],
					nativeHost,
				}),
			).toThrow(pattern);
		}
	});

	it("ignores requirements that name something else entirely", () => {
		// A `postgres` requirement is not a placement request. Matching it would
		// move actors off native for a reason unrelated to actors.
		const resolved = resolveActorPlacement({
			campRuntimeRequirements: ["postgres", "redis", "daprless"],
			nativeHost,
		});
		expect(resolved.mode).toBe("native");
		expect(resolved.source).toBe("default");
	});

	it("treats an absent requirements list as empty", () => {
		expect(
			resolveActorPlacement({
				campRuntimeRequirements: undefined,
				nativeHost,
			}).mode,
		).toBe("native");
	});

	it("lets an explicit native pin override a Camp's dapr requirement", () => {
		// Explicit wins, and says so. An operator pinning native for an
		// investigation must not be silently overridden by the Camp manifest.
		const resolved = resolveActorPlacement({
			explicit: "native",
			campRuntimeRequirements: ["dapr"],
			nativeHost,
			daprHost,
		});
		expect(resolved.mode).toBe("native");
		expect(resolved.source).toBe("explicit");
	});
});

describe("signalActor", () => {
	it("publishes to the actor type's topic keyed by the actor key", async () => {
		// The key is the partition key: without it, two messages for the same
		// grain could land on different partitions and be delivered out of order
		// to a single-writer actor.
		const published: Array<{ topic: string; body: unknown; key?: string }> = [];
		await signalActor(
			{
				publish: async (topic, body, options) => {
					published.push({ topic, body, key: options?.key });
					return undefined;
				},
			},
			"Cart",
			"cart-1",
			{ type: "addItem" },
		);
		expect(published).toEqual([
			{ topic: "actors.Cart", body: { type: "addItem" }, key: "cart-1" },
		]);
	});

	it("awaits the publish rather than firing and forgetting", async () => {
		// A caller that returns before the publish settled would report a signal
		// as delivered when the broker had not accepted it.
		let settled = false;
		await signalActor(
			{
				publish: async () => {
					await Promise.resolve();
					settled = true;
					return undefined;
				},
			},
			"Cart",
			"cart-1",
			{},
		);
		expect(settled).toBe(true);
	});

	it("propagates a publish failure", async () => {
		// Not swallowed: a dropped signal to a durable actor is lost work, and
		// the caller is the only one who can retry it.
		await expect(
			signalActor(
				{
					publish: async () => {
						throw new Error("broker down");
					},
				},
				"Cart",
				"cart-1",
				{},
			),
		).rejects.toThrow("broker down");
	});
});
