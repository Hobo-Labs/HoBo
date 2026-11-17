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

function hostNamed(name: string): ActorHost & { name: string } {
	return {
		name,
		acquire() {
			throw new Error("placement fixture cannot acquire a lease");
		},
		state() {
			throw new Error("placement fixture cannot open state");
		},
	};
}

describe("capability namespacing helpers", () => {
	it("namespaces tool and token capabilities", () => {
		expect(toolCapability("search")).toBe("tool:search");
		expect(tokenCapability("aws")).toBe("token:aws");
		expect(toolCapability("aws")).not.toBe(tokenCapability("aws"));
	});
});

describe("createRuntimeContext durability primitives", () => {
	it("passes step, sleep, emit, now and random through ungated", () => {
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
		const ctx = contextWith(["actor"]);
		expect(Object.isFrozen(ctx)).toBe(true);
		expect([...ctx.capabilities]).toEqual(["actor"]);
	});

	it("copies the capability iterable rather than aliasing it", () => {
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
		const ctx = contextWith(["tool:deploy"]);
		expect(() => ctx.requireCapability("tool:deploy-prod")).toThrow(
			CapabilityDeniedError,
		);
		expect(() => ctx.requireCapability("tool")).toThrow(CapabilityDeniedError);
	});
});

describe("ctx.actor", () => {
	const stub = {
		key: "k",
		signal: async () => 1,
		state: async () => {
			throw new Error("actor fixture has no state");
		},
	};

	it("delegates once the actor capability is declared", () => {
		const ctx = contextWith(["actor"], { actor: () => stub });
		expect(ctx.actor({ typeName: "Cart", key: "k" })).toBe(stub);
	});

	it("denies an undeclared reach", () => {
		const ctx = contextWith([], { actor: () => stub });
		expect(() => ctx.actor({ typeName: "Cart", key: "k" })).toThrow(
			CapabilityDeniedError,
		);
	});

	it("denies when granted but the engine wired no implementation", () => {
		const ctx = contextWith(["actor"]);
		expect(() => ctx.actor({ typeName: "Cart", key: "k" })).toThrow(
			CapabilityDeniedError,
		);
	});
});

describe("ctx.token", () => {
	const handle = { token: "t" } as never;

	it("requires the capability for the specific provider", () => {
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
		expect(new RetryableError("again").retries).toBeUndefined();
		expect(new RetryableError("again", { retries: 3 }).retries).toBe(3);
		expect(new RetryableError("again", { retries: 0 }).retries).toBe(0);
	});

	it("WorkflowFailure names the step and keeps the cause", () => {
		const cause = new Error("timeout");
		const failure = new WorkflowFailure("failed", { step: "charge", cause });
		expect(failure.step).toBe("charge");
		expect(failure.cause).toBe(cause);
		const stepless = new WorkflowFailure("failed", {});
		expect(stepless.step).toBeUndefined();
		expect(stepless.cause).toBeUndefined();
	});

	it("CapabilityDeniedError copies the granted list", () => {
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
		for (const explicit of ["dapr", "rivet", "celld"] as const) {
			expect(() => resolveActorPlacement({ explicit, nativeHost })).toThrow(
				new RegExp(`'${explicit}' requires a`, "u"),
			);
		}
	});

	it("refuses an unparseable explicit mode", () => {
		expect(() =>
			resolveActorPlacement({ explicit: "kubernetes", nativeHost }),
		).toThrow();
		expect(() => resolveActorPlacement({ explicit: 7, nativeHost })).toThrow();
	});

	it("treats an explicit undefined as absent rather than as a pin", () => {
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
		const published: Array<{ topic: string; body: unknown; key?: string }> = [];
		await signalActor(
			{
				publish: async (topic, body, options) => {
					published.push({ topic, body, key: options?.key });
					return null;
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
		let settled = false;
		await signalActor(
			{
				publish: async () => {
					await Promise.resolve();
					settled = true;
					return null;
				},
			},
			"Cart",
			"cart-1",
			{},
		);
		expect(settled).toBe(true);
	});

	it("propagates a publish failure", async () => {
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
