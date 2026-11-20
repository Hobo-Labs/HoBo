import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { State, type StateService } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	alchemyTarget,
	createAlchemyIacProvider,
	type FinancialPlan,
} from "../src/index.js";
import { routeFixture, testOperation } from "./route-fixture.js";

const timerHarness = vi.hoisted(() => {
	vi.resetModules();
	const nativeSet = globalThis.setTimeout;
	const nativeClear = globalThis.clearTimeout;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the bridge forwards the Node timer's arguments without changing them.
	const schedule = ((
		handler: (...args: unknown[]) => void,
		timeout?: number,
		...args: unknown[]
	) => {
		const current = globalThis.setTimeout;
		return (current === schedule ? nativeSet : current)(
			handler,
			timeout,
			...args,
		);
	}) as typeof setTimeout;
	// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: the bridge forwards the timer handle to the active test clock.
	const cancel = ((handle: ReturnType<typeof setTimeout>) => {
		const current = globalThis.clearTimeout;
		(current === cancel ? nativeClear : current)(handle);
	}) as typeof clearTimeout;
	globalThis.setTimeout = schedule;
	globalThis.clearTimeout = cancel;
	return { nativeSet, nativeClear };
});
globalThis.setTimeout = timerHarness.nativeSet;
globalThis.clearTimeout = timerHarness.nativeClear;

type Widget = Resource<"Spec.Widget", Record<string, never>, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
const program = {
	programId: "p",
	deploymentId: "d",
	resourceId: "app",
	provider: "test",
	driver: "external",
	action: "apply" as const,
	stackName: "App",
	operationGeneration: "generation",
};
function deferred() {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

function fixture(
	directory: string,
	timeout = 5_000,
	createProvider = createAlchemyIacProvider,
	onRevalidate: () => void = () => {},
	onResolve: () => void = () => {},
) {
	const gate = deferred();
	const started = deferred();
	const completed = deferred();
	let block:
		| "none"
		| "plan"
		| "resolve"
		| "route"
		| "verify"
		| "consume"
		| "admit"
		| "revalidate"
		| "provider"
		| "deny"
		| "finish"
		| "ownership-plan-all"
		| "ownership-plan-1"
		| "ownership-plan-2"
		| "ownership-plan-3"
		| "ownership-apply"
		| "ownership-complete"
		| "ownership-drift" = "none";
	let effects = 0;
	let plans = 0;
	let stateReads = 0;
	let ownershipPlans = 0;
	let ownershipCalls = 0;
	let ownershipResult: "accept" | "reject" | "throw" = "accept";
	let planAllowed = true;
	let assessmentThrows = false;
	let synchronousPhase = "none";
	const synchronousWait = (phase: string) => {
		if (synchronousPhase === phase)
			Atomics.wait(
				new Int32Array(new SharedArrayBuffer(4)),
				0,
				0,
				timeout + 250,
			);
	};
	let hangUncertain = false;
	let admissions = 0;
	let routeCalls = 0;
	const outcomes: string[] = [];
	const uncertain: string[] = [];
	const routes = routeFixture();
	const base = routes.port;
	const state = Layer.effect(
		State,
		Effect.map(State, (effect) =>
			Effect.map(effect, (service) =>
				Object.assign(Object.create(service), {
					list: (request: Parameters<StateService["list"]>[0]) => {
						stateReads++;
						return service.list(request);
					},
				}),
			),
		),
	).pipe(Layer.provide(inMemoryState()));
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.gen(function* () {
						effects++;
						synchronousWait("provider");
						if (block === "provider") {
							started.resolve();
							yield* Effect.promise(() => gate.promise);
						}
						return { id: "widget" };
					}),
				delete: () => Effect.void,
			}),
			state,
		},
		Effect.gen(function* () {
			plans++;
			if (block === "plan") {
				started.resolve();
				yield* Effect.promise(() => gate.promise);
			}
			yield* Widget("widget", {});
			return {};
		}),
	);
	const provider = createProvider({
		stack,
		stateOwnership: {
			backendRef: "test:state",
			ownershipEpoch: "test:epoch",
			verify: async ({ phase }) => {
				ownershipCalls++;
				if (phase === "plan") ownershipPlans++;
				synchronousWait(
					phase === "plan"
						? `ownership-plan-${ownershipPlans}`
						: `ownership-${phase}`,
				);
				if (
					block === `ownership-${phase}` ||
					(phase === "plan" && block === "ownership-plan-all") ||
					(phase === "plan" && block === `ownership-plan-${ownershipPlans}`)
				) {
					started.resolve();
					await gate.promise;
					if (ownershipResult === "throw") throw new Error("revoked");
					if (ownershipResult === "reject") return false;
				}
				return true;
			},
		},
		operationTimeoutMs: timeout,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: directory,
		route: {
			...base,
			verifyAttempt: async (permit) => {
				if (block === "verify") {
					started.resolve();
					await gate.promise;
				}
				return base.verifyAttempt(permit);
			},
			consumeAttempt: async (permit) => {
				if (block === "consume") {
					started.resolve();
					await gate.promise;
				}
				return base.consumeAttempt(permit);
			},
			runDirect: async (input, run) => {
				routeCalls++;
				if (block === "route") {
					started.resolve();
					await gate.promise;
				}
				const result = await base.runDirect(input, async (attempt) => {
					const completion = await run({
						...attempt,
						deny: async () => {
							if (block === "deny") {
								started.resolve();
								await gate.promise;
							}
							await attempt.deny();
						},
					});
					outcomes.push(completion.outcome.status);
					completed.resolve();
					return completion;
				});
				if (block === "finish") {
					started.resolve();
					await gate.promise;
				}
				return result;
			},
		},
		resolveRoute: async ({ requestId }) => {
			synchronousWait("resolve");
			if (block === "resolve") {
				onResolve();
				started.resolve();
				await gate.promise;
			}
			return { requestId: requestId ?? "request", operation: testOperation };
		},
		target: alchemyTarget({
			targetId: "t",
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory",
			resources: [
				{
					resourceId: "widget",
					resourceType: "Spec.Widget",
					providerId: "test",
					providerAccountRef: "account",
					productId: "widget",
				},
			],
		}),
		composite: {
			proofRef: "host",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: () => planAllowed,
		},
		financial: {
			assess: (plan: FinancialPlan) => {
				synchronousWait("assess");
				if (assessmentThrows) throw new Error("assessment unavailable");
				return { plan };
			},
			admit: async (requestId) => {
				admissions++;
				synchronousWait("admit");
				if (block === "admit") {
					started.resolve();
					await gate.promise;
				}
				return {
					requestId,
					targetId: "t",
					status: "admitted",
					code: "",
					message: "",
					budget: { evaluation: "allowed", reservation: "held" },
					reservation: { reservationId: `iac:${requestId}` },
					requestDigest: `sha256:${"b".repeat(64)}`,
					inventoryHash: `sha256:${"c".repeat(64)}`,
					modelHash: `sha256:${"d".repeat(64)}`,
					quoteHash: `sha256:${"e".repeat(64)}`,
				};
			},
			revalidate: async () => {
				synchronousWait("revalidate");
				if (block === "revalidate") {
					onRevalidate();
					started.resolve();
					await gate.promise;
				}
				return true;
			},
			uncertain: (id) => {
				uncertain.push(id);
				return hangUncertain ? new Promise<void>(() => {}) : undefined;
			},
		},
	});
	return {
		provider,
		gate,
		started,
		completed,
		hangUncertain: () => {
			hangUncertain = true;
		},
		ownershipResult: (result: typeof ownershipResult) => {
			ownershipResult = result;
		},
		synchronousBlock: (phase: string) => {
			synchronousPhase = phase;
			ownershipPlans = 0;
		},
		denyPlan: () => {
			planAllowed = false;
		},
		failAssessment: () => {
			assessmentThrows = true;
		},
		block: (phase: typeof block) => {
			block = phase;
			ownershipPlans = 0;
		},
		observed: () => ({
			effects,
			plans,
			stateReads,
			ownershipPlans,
			ownershipCalls,
			admissions,
			routeCalls,
			denials: routes.calls.denied,
			outcomes,
			uncertain,
		}),
	};
}

function timers() {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}
async function expire() {
	await vi.advanceTimersByTimeAsync(5_001);
}

async function waitForPhase(
	started: Promise<void>,
	operation: Promise<unknown>,
) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			started,
			operation.then(
				() => {
					throw new Error("operation completed before the expected phase");
				},
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: rejected values are retained only as an opaque test error cause.
				(error: unknown) => {
					throw new Error("operation failed before the expected phase", {
						cause: error,
					});
				},
			),
			new Promise<never>((_resolve, reject) => {
				timer = realSetTimeout(
					() => reject(new Error("expected phase did not start")),
					4_000,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) realClearTimeout(timer);
	}
}

describe("bounded Alchemy execution deadlines", () => {
	it("latches a pre-route timeout without reading an inherited reservation field", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const oldHome = process.env.ALCHEMY_HOME;
		const oldField = Object.getOwnPropertyDescriptor(
			Object.prototype,
			"reservationId",
		);
		process.env.ALCHEMY_HOME = join(dir, "home");
		let traps = 0;
		try {
			const f = fixture(
				dir,
				5_000,
				createAlchemyIacProvider,
				() => {},
				() => {
					Object.defineProperty(Object.prototype, "reservationId", {
						configurable: true,
						get() {
							traps++;
							throw new Error("inherited reservation was read");
						},
					});
				},
			);
			await f.provider.preview(program);
			f.block("resolve");
			const operation = f.provider.applyWithAdmission(program, "request");
			const observed = operation.then(
				() => undefined,
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: the rejection is retained only for the assertion.
				(error: unknown) => error,
			);
			await f.started.promise;
			await expire();
			const failure = await observed;
			if (oldField === undefined)
				Reflect.deleteProperty(Object.prototype, "reservationId");
			else Object.defineProperty(Object.prototype, "reservationId", oldField);
			expect(traps).toBe(0);
			expect(failure).toMatchObject({
				code: "EXECUTION_DEADLINE_BEFORE_ROUTE",
				requiresReconciliation: true,
			});
			f.gate.resolve();
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ requiresReconciliation: true });
		} finally {
			if (oldField === undefined)
				Reflect.deleteProperty(Object.prototype, "reservationId");
			else Object.defineProperty(Object.prototype, "reservationId", oldField);
			if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = oldHome;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("retains the admitted hold when an authority replaces scheduling intrinsics and later returns", async () => {
		vi.resetModules();
		const { createAlchemyIacProvider: createNativeProvider } = await import(
			"../src/index.js"
		);
		const { digestData } = await import("../src/plan.js");
		const fenceKey = digestData({
			tenantId: "tenant",
			targetId: "t",
			deploymentId: program.deploymentId,
			resourceId: program.resourceId,
		});
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		const nativeSet = globalThis.setTimeout;
		const nativeClear = globalThis.clearTimeout;
		const nativeResolve = Promise.resolve;
		const nativeRace = Promise.race;
		const nativeMax = Math.max;
		const nativeMapGet = Map.prototype.get;
		const nativeMapHas = Map.prototype.has;
		const nativeMapSet = Map.prototype.set;
		const nativeMapDelete = Map.prototype.delete;
		const nativeSetAdd = Set.prototype.add;
		const nativeSetDelete = Set.prototype.delete;
		const apply = Reflect.apply;
		let traps = 0;
		let intercepted = 0;
		const poison = () => {
			traps++;
			throw new Error("mutable intrinsic invoked");
		};
		try {
			const f = fixture(dir, 1_000, createNativeProvider, () => {
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: each stand-in always throws, so its arguments and result are never used.
				globalThis.setTimeout = poison as typeof setTimeout;
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: each stand-in always throws, so its arguments and result are never used.
				globalThis.clearTimeout = poison as typeof clearTimeout;
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: each stand-in always throws, so its arguments and result are never used.
				Promise.resolve = poison as typeof Promise.resolve;
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: each stand-in always throws, so its arguments and result are never used.
				Promise.race = poison as typeof Promise.race;
				Math.max = poison;

				Map.prototype.get = function (key) {
					if (key === fenceKey) {
						intercepted++;
						return undefined;
					}
					return apply(nativeMapGet, this, [key]);
				};
				Map.prototype.has = function (key) {
					if (key === fenceKey) {
						intercepted++;
						return false;
					}
					return apply(nativeMapHas, this, [key]);
				};
				Map.prototype.set = function (key, value) {
					if (key === fenceKey) {
						intercepted++;
						return this;
					}
					return apply(nativeMapSet, this, [key, value]);
				};
				Map.prototype.delete = function (key) {
					if (key === fenceKey) {
						intercepted++;
						return false;
					}
					return apply(nativeMapDelete, this, [key]);
				};
				Set.prototype.add = function (value) {
					if (value === fenceKey) {
						intercepted++;
						return this;
					}
					return apply(nativeSetAdd, this, [value]);
				};
				Set.prototype.delete = function (value) {
					if (value === fenceKey) {
						intercepted++;
						return false;
					}
					return apply(nativeSetDelete, this, [value]);
				};
			});
			await f.provider.preview(program);
			f.block("revalidate");
			const operation = f.provider.applyWithAdmission(program, "request");
			const observed = operation.then(
				() => undefined,
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: the rejection is retained only for the assertion.
				(error: unknown) => error,
			);
			await f.started.promise;
			const failure = await observed;
			globalThis.setTimeout = nativeSet;
			globalThis.clearTimeout = nativeClear;
			Promise.resolve = nativeResolve;
			Promise.race = nativeRace;
			Math.max = nativeMax;
			Map.prototype.get = nativeMapGet;
			Map.prototype.has = nativeMapHas;
			Map.prototype.set = nativeMapSet;
			Map.prototype.delete = nativeMapDelete;
			Set.prototype.add = nativeSetAdd;
			Set.prototype.delete = nativeSetDelete;
			expect(failure).toMatchObject({
				code: "EXECUTION_DEADLINE_AFTER_ADMISSION",
				requiresReconciliation: true,
				reservationId: "iac:request",
			});
			expect(traps).toBe(0);
			expect(intercepted).toBe(0);
			f.gate.resolve();
			await f.completed.promise;
			expect(f.observed()).toMatchObject({
				effects: 0,
				outcomes: ["uncertain"],
				uncertain: ["iac:request"],
			});
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "EXECUTION_ALREADY_CLAIMED",
				requiresReconciliation: true,
				reservationId: "iac:request",
			});
		} finally {
			globalThis.setTimeout = nativeSet;
			globalThis.clearTimeout = nativeClear;
			Promise.resolve = nativeResolve;
			Promise.race = nativeRace;
			Math.max = nativeMax;
			Map.prototype.get = nativeMapGet;
			Map.prototype.has = nativeMapHas;
			Map.prototype.set = nativeMapSet;
			Map.prototype.delete = nativeMapDelete;
			Set.prototype.add = nativeSetAdd;
			Set.prototype.delete = nativeSetDelete;
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("reports an operation that ends before its expected phase", async () => {
		const never = new Promise<void>(() => {});
		await expect(
			waitForPhase(never, Promise.reject(new Error("early"))),
		).rejects.toThrow("operation failed before the expected phase");
	});
	it("rejects proxied and revoked expectations and permits without running traps", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir, 5_000);
			await f.provider.preview(program);
			const expected = {
				targetId: "t",
				inventoryHash: `sha256:${"c".repeat(64)}`,
				modelHash: `sha256:${"d".repeat(64)}`,
				quoteHash: `sha256:${"e".repeat(64)}`,
			};
			const permit = {
				tenantId: "tenant",
				requestId: "request",
				operationId: testOperation.operationId,
				targetId: "t",
				inventoryHash: expected.inventoryHash,
				attemptId: "A".repeat(43),
			};
			type RouteInput = typeof expected | typeof permit;
			for (const mode of [
				"ownKeys",
				"descriptor",
				"transparent",
				"revoked",
			] as const) {
				let traps = 0;
				const handler = {
					ownKeys: (target: RouteInput) => {
						traps++;
						if (mode === "ownKeys") throw new Error("ownKeys trap");
						return Reflect.ownKeys(target);
					},
					getOwnPropertyDescriptor: (
						target: RouteInput,
						key: string | symbol,
					) => {
						traps++;
						if (mode === "descriptor") throw new Error("descriptor trap");
						return Reflect.getOwnPropertyDescriptor(target, key);
					},
				};
				const expectationProxy = Proxy.revocable(expected, handler);
				const permitProxy = Proxy.revocable(permit, handler);
				if (mode === "revoked") {
					expectationProxy.revoke();
					permitProxy.revoke();
				}
				await expect(
					f.provider.applyWithAdmission(
						program,
						"request",
						expectationProxy.proxy,
					),
				).rejects.toMatchObject({ code: "EXPECTATION_INVALID" });
				await expect(
					f.provider.applyWithAdmission(
						program,
						"request",
						undefined,
						permitProxy.proxy,
					),
				).rejects.toMatchObject({ code: "ROUTE_PERMIT_UNVERIFIED" });
				expect(traps).toBe(0);
			}
			expect(f.observed()).toMatchObject({
				routeCalls: 0,
				admissions: 0,
				effects: 0,
			});
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		["resolve", "EXECUTION_DEADLINE_BEFORE_ROUTE", "not-started", 0, 0],
		["admit", "ADMISSION_DEADLINE_UNKNOWN", "not-started", 0, 1],
		["revalidate", "EXECUTION_DEADLINE_AFTER_ADMISSION", "not-started", 0, 1],
		["provider", "PROVIDER_DEADLINE_UNKNOWN", "unknown", 1, 1],
		[
			"ownership-complete",
			"ROUTE_COMPLETION_DEADLINE_UNKNOWN",
			"completed",
			1,
			1,
		],
	] as const)("honors the absolute deadline after synchronous %s blocks the timer", async (phase, code, executionOutcome, effects, routeCalls) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir, 1_200);
			await f.provider.preview(program);
			f.synchronousBlock(phase);
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code,
				executionOutcome,
				requiresReconciliation: true,
			});
			if (routeCalls) await f.completed.promise;
			expect(f.observed()).toMatchObject({ effects, routeCalls });
			if (routeCalls) expect(f.observed().outcomes).toEqual(["uncertain"]);
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ requiresReconciliation: true });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not publish a pricing plan after its synchronous verifier overruns", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir, 1_200);
			await f.provider.preview(program);
			f.synchronousBlock("ownership-plan-2");
			await expect(f.provider.preview(program)).rejects.toMatchObject({
				code: "PREVIEW_DEADLINE_EXCEEDED",
				executionOutcome: "not-started",
			});
			f.synchronousBlock("none");
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("uses the captured monotonic clock even if the process clock property changes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		const originalClock = process.hrtime.bigint;
		try {
			const f = fixture(dir, 1_200);
			await f.provider.preview(program);
			f.synchronousBlock("revalidate");
			process.hrtime.bigint = () => 0n;
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "EXECUTION_DEADLINE_AFTER_ADMISSION",
				requiresReconciliation: true,
			});
			await f.completed.promise;
			expect(f.observed()).toMatchObject({
				effects: 0,
				outcomes: ["uncertain"],
			});
		} finally {
			process.hrtime.bigint = originalClock;
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		"throw",
		"overrun",
		"overrun-throw",
	] as const)("does not publish a preview when financial assessment can %s", async (failure) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir, 1_200);
			await f.provider.preview(program);
			if (failure === "throw" || failure === "overrun-throw")
				f.failAssessment();
			if (failure === "overrun" || failure === "overrun-throw")
				f.synchronousBlock("assess");
			const result = f.provider.preview(program);
			if (failure === "throw")
				await expect(result).rejects.toMatchObject({
					code: "PRICING_ASSESSMENT_UNAVAILABLE",
				});
			else
				await expect(result).rejects.toMatchObject({
					code: "PREVIEW_DEADLINE_EXCEEDED",
				});
			f.synchronousBlock("none");
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
			expect(f.observed()).toMatchObject({ admissions: 0, effects: 0 });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("captures program, expectation, and route permit before deferred work", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir, 5_000);
			const previewInput = { ...program };
			const preview = f.provider.preview(previewInput);
			previewInput.resourceId = "changed";
			await preview;
			const applyInput = { ...program };
			const expected = {
				targetId: "t",
				inventoryHash: `sha256:${"c".repeat(64)}`,
				modelHash: `sha256:${"d".repeat(64)}`,
				quoteHash: `sha256:${"e".repeat(64)}`,
			};
			const permit = {
				tenantId: "tenant",
				requestId: "request",
				operationId: testOperation.operationId,
				targetId: "t",
				inventoryHash: expected.inventoryHash,
				attemptId: "A".repeat(43),
			};
			const result = f.provider.applyWithAdmission(
				applyInput,
				"request",
				expected,
				permit,
			);
			applyInput.resourceId = "changed";
			expected.targetId = "changed";
			permit.targetId = "changed";
			await expect(result).resolves.toMatchObject({
				admission: { reservation: { reservationId: "iac:request" } },
			});
			expect(f.observed().effects).toBe(1);
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("counts timed-out planning work until the underlying callbacks finish", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir, 5_000);
			f.block("ownership-plan-all");

			const reads = Array.from({ length: 128 }, () =>
				f.provider.preview(program).then(
					() => "unexpected success",
					(error: { code: string }) => error.code,
				),
			);
			await f.started.promise;
			await expect(f.provider.preview(program)).rejects.toMatchObject({
				code: "READ_OPERATION_LIMIT",
			});
			await vi.advanceTimersByTimeAsync(5_001);
			expect(await Promise.all(reads)).toEqual(
				Array(128).fill("PREVIEW_DEADLINE_EXCEEDED"),
			);
			await expect(f.provider.refresh(program)).rejects.toMatchObject({
				code: "READ_OPERATION_LIMIT",
			});
			f.block("none");
			f.gate.resolve();
			await vi.advanceTimersByTimeAsync(1);
			await expect(f.provider.preview(program)).resolves.toBeDefined();
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reserves execution capacity before scheduling a synchronous burst", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir, 5_000);
			await f.provider.preview(program);
			f.block("ownership-plan-all");
			const attempts = Array.from({ length: 300 }, (_, index) =>
				f.provider
					.applyWithAdmission(
						index === 0
							? program
							: { ...program, deploymentId: `deployment-${index}` },
						"request",
					)
					.then(
						() => "unexpected success",
						(error: { code: string }) => error.code,
					),
			);
			expect(vi.getTimerCount()).toBeLessThanOrEqual(128);
			await f.started.promise;
			await vi.advanceTimersByTimeAsync(5_001);
			const outcomes = await Promise.all(attempts);
			expect(
				outcomes.filter((code) => code === "EXECUTION_LIMIT"),
			).toHaveLength(172);
			expect(
				outcomes.filter((code) => code === "PREVIEW_REQUIRED"),
			).toHaveLength(127);
			expect(
				outcomes.filter((code) => code === "EXECUTION_DEADLINE_BEFORE_ROUTE"),
			).toHaveLength(1);
			f.gate.resolve();
			await vi.advanceTimersByTimeAsync(1);
			expect(f.observed()).toMatchObject({
				routeCalls: 0,
				admissions: 0,
				effects: 0,
			});
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("enforces preview cache capacity when two plans complete concurrently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir, 5_000);
			for (let index = 0; index < 127; index++)
				await f.provider.preview({
					...program,
					operationGeneration: `generation-${index}`,
				});
			f.block("ownership-plan-all");
			const candidates = [127, 128].map((index) =>
				f.provider.preview({
					...program,
					operationGeneration: `generation-${index}`,
				}),
			);
			const results = Promise.allSettled(candidates);
			await f.started.promise;
			for (
				let attempts = 0;
				attempts < 100 && f.observed().ownershipPlans < 2;
				attempts++
			)
				await new Promise<void>((resolve) => setImmediate(resolve));
			expect(f.observed().ownershipPlans).toBe(2);
			f.gate.resolve();
			const outcomes = await results;
			expect(
				outcomes.filter((outcome) => outcome.status === "fulfilled"),
			).toHaveLength(1);
			const failures = outcomes.filter(
				(outcome) => outcome.status === "rejected",
			);
			expect(failures).toHaveLength(1);
			expect(failures[0]).toMatchObject({ reason: { code: "PREVIEW_LIMIT" } });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("bounds a stalled preview and never publishes a late preview", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block("plan");
			const outcome = expect(f.provider.preview(program)).rejects.toMatchObject(
				{ code: "PREVIEW_DEADLINE_EXCEEDED", executionOutcome: "not-started" },
			);
			await f.started.promise;
			await expire();
			await outcome;
			f.gate.resolve();
			await vi.advanceTimersByTimeAsync(1);
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
			expect(f.observed().effects).toBe(0);
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("bounds a stalled refresh without invoking late host callbacks or provider work", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block("plan");
			const outcome = expect(f.provider.refresh(program)).rejects.toMatchObject(
				{ code: "REFRESH_DEADLINE_EXCEEDED", executionOutcome: "not-started" },
			);
			await f.started.promise;
			await expire();
			await outcome;
			f.gate.resolve();
			await vi.advanceTimersByTimeAsync(1);
			expect(f.observed().effects).toBe(0);
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		"preview",
		"refresh",
	] as const)("bounds a stalled ownership verifier during %s without planning later", async (operation) => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			f.block("ownership-plan-1");
			const result = expect(
				f.provider[operation](program),
			).rejects.toMatchObject({
				code:
					operation === "preview"
						? "PREVIEW_DEADLINE_EXCEEDED"
						: "REFRESH_DEADLINE_EXCEEDED",
				executionOutcome: "not-started",
			});
			await f.started.promise;
			await expire();
			await result;
			f.gate.resolve();
			await vi.advanceTimersByTimeAsync(1);
			expect(f.observed()).toMatchObject({ plans: 0, effects: 0 });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		"accept",
		"reject",
		"throw",
	] as const)("does not run the final pricing state scan after late ownership %s", async (decision) => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block("ownership-plan-2");
			f.ownershipResult(decision);
			const result = expect(f.provider.preview(program)).rejects.toMatchObject({
				code: "PREVIEW_DEADLINE_EXCEEDED",
				executionOutcome: "not-started",
			});
			await f.started.promise;
			const before = f.observed().stateReads;
			await expire();
			await result;
			f.gate.resolve();
			await vi.advanceTimersByTimeAsync(1);
			expect(f.observed().stateReads).toBe(before);
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
			expect(f.observed().effects).toBe(0);
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		[
			"ownership-plan-1",
			"EXECUTION_DEADLINE_BEFORE_ROUTE",
			"not-started",
			0,
			0,
		],
		["ownership-plan-2", "ROUTE_DEADLINE_UNKNOWN", "not-started", 0, 1],
		["ownership-plan-3", "ROUTE_DEADLINE_UNKNOWN", "not-started", 0, 1],
		[
			"ownership-apply",
			"EXECUTION_DEADLINE_AFTER_ADMISSION",
			"not-started",
			0,
			1,
		],
		[
			"ownership-complete",
			"ROUTE_COMPLETION_DEADLINE_UNKNOWN",
			"completed",
			1,
			1,
		],
	] as const)("latches a late %s ownership decision", async (phase, code, executionOutcome, effects, routeCalls) => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block(phase);
			const result = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code,
				executionOutcome,
				requiresReconciliation: true,
			});
			await f.started.promise;
			await expire();
			await result;
			f.gate.resolve();
			if (routeCalls) await f.completed.promise;
			else await vi.advanceTimersByTimeAsync(1);
			expect(f.observed()).toMatchObject({ effects, routeCalls, denials: 0 });
			if (routeCalls) expect(f.observed().outcomes).toEqual(["uncertain"]);
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ requiresReconciliation: true });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		"accept",
		"reject",
		"throw",
	] as const)("never starts a provider when a timed-out final ownership verifier later returns %s", async (decision) => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block("ownership-apply");
			f.ownershipResult(decision);
			const operation = f.provider.applyWithAdmission(program, "request");
			await waitForPhase(f.started.promise, operation);
			await expire();
			await expect(operation).rejects.toMatchObject({
				code: "EXECUTION_DEADLINE_AFTER_ADMISSION",
				requiresReconciliation: true,
			});
			f.gate.resolve();
			await f.completed.promise;
			expect(f.observed()).toMatchObject({
				effects: 0,
				denials: 0,
				outcomes: ["uncertain"],
			});
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		"resolve",
		"route",
		"verify",
		"consume",
	] as const)("stops a late %s callback before admission or provider work", async (phase) => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block(phase);
			const outcome = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code:
					phase === "resolve"
						? "EXECUTION_DEADLINE_BEFORE_ROUTE"
						: "ROUTE_DEADLINE_UNKNOWN",
				executionOutcome: "not-started",
				requiresReconciliation: true,
			});
			await f.started.promise;
			await expire();
			await outcome;
			f.gate.resolve();
			await vi.advanceTimersByTimeAsync(1);
			if (phase !== "resolve") await f.completed.promise;
			expect(f.observed().admissions).toBe(0);
			expect(f.observed().effects).toBe(0);
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ requiresReconciliation: true });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("treats a late admission as uncertain and never starts the provider", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block("admit");
			const outcome = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "ADMISSION_DEADLINE_UNKNOWN",
				executionOutcome: "not-started",
				requiresReconciliation: true,
			});
			await f.started.promise;
			await expire();
			await outcome;
			f.gate.resolve();
			await f.completed.promise;
			expect(f.observed()).toMatchObject({
				effects: 0,
				admissions: 1,
				outcomes: ["uncertain"],
				uncertain: ["iac:request"],
			});
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ requiresReconciliation: true });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("blocks another generation while an admission is running or unresolved", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			const next = { ...program, operationGeneration: "another-generation" };
			await f.provider.preview(program);
			await f.provider.preview(next);
			f.block("admit");
			const first = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "ADMISSION_DEADLINE_UNKNOWN",
				requiresReconciliation: true,
			});
			await f.started.promise;
			await expect(
				f.provider.applyWithAdmission(next, "another-request"),
			).rejects.toMatchObject({
				code: "EXECUTION_IN_PROGRESS",
				requiresReconciliation: true,
			});
			await expire();
			await first;
			await expect(
				f.provider.applyWithAdmission(next, "another-request"),
			).rejects.toMatchObject({
				code: "EXECUTION_OUTCOME_UNRESOLVED",
				requiresReconciliation: true,
			});
			f.gate.resolve();
			await f.completed.promise;
			expect(f.observed()).toMatchObject({
				routeCalls: 1,
				admissions: 1,
				effects: 0,
				outcomes: ["uncertain"],
				uncertain: ["iac:request"],
			});
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("keeps a delayed no-effect denial uncertain after the response deadline", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.denyPlan();
			f.block("deny");
			const result = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "ROUTE_DEADLINE_UNKNOWN",
				executionOutcome: "not-started",
				requiresReconciliation: true,
			});
			await f.started.promise;
			await expire();
			await result;
			f.gate.resolve();
			await f.completed.promise;
			expect(f.observed()).toMatchObject({
				effects: 0,
				admissions: 0,
				denials: 1,
				outcomes: ["uncertain"],
			});
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ requiresReconciliation: true });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("retains a claimed hold when financial revalidation stalls", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block("revalidate");
			const outcome = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "EXECUTION_DEADLINE_AFTER_ADMISSION",
				executionOutcome: "not-started",
				requiresReconciliation: true,
				reservationId: "iac:request",
			});
			await f.started.promise;
			await expire();
			await outcome;
			f.gate.resolve();
			await f.completed.promise;
			expect(f.observed().effects).toBe(0);
			expect(f.observed().uncertain).toContain("iac:request");
			expect(f.observed().outcomes).toEqual(["uncertain"]);
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("reports a late provider completion as unknown and does not declare the route selected", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block("provider");
			const outcome = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "PROVIDER_DEADLINE_UNKNOWN",
				executionOutcome: "unknown",
				requiresReconciliation: true,
				reservationId: "iac:request",
			});
			await f.started.promise;
			await expire();
			await outcome;
			f.gate.resolve();
			await f.completed.promise;
			expect(f.observed().effects).toBe(1);
			expect(f.observed().outcomes).toEqual(["uncertain"]);
			expect(f.observed().uncertain).toContain("iac:request");
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("reports provider completion when only the route acknowledgement stalls", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.block("finish");
			const outcome = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "ROUTE_COMPLETION_DEADLINE_UNKNOWN",
				executionOutcome: "completed",
				requiresReconciliation: true,
				reservationId: "iac:request",
			});
			await f.started.promise;
			await expire();
			await outcome;
			expect(f.observed().effects).toBe(1);
			expect(f.observed().uncertain).toContain("iac:request");
			f.gate.resolve();
			await vi.advanceTimersByTimeAsync(1);
			await expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({ requiresReconciliation: true });
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("returns a deadline outcome even when uncertainty recording never responds", async () => {
		timers();
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		const old = process.env.ALCHEMY_HOME;
		process.env.ALCHEMY_HOME = join(dir, "home");
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.hangUncertain();
			f.block("revalidate");
			const outcome = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "EXECUTION_DEADLINE_AFTER_ADMISSION",
				requiresReconciliation: true,
				reservationId: "iac:request",
			});
			await f.started.promise;
			await expire();
			await outcome;
			f.gate.resolve();
			await f.completed.promise;
			expect(f.observed().effects).toBe(0);
			expect(f.observed().uncertain).toContain("iac:request");
		} finally {
			if (old === undefined) delete process.env.ALCHEMY_HOME;
			else process.env.ALCHEMY_HOME = old;
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		0,
		-1,
		3_600_001,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		null,
		"50",
	])("rejects an invalid deadline %s before executing stack code", (timeout) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-iac-deadline-"));
		try {
			// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: exercise untyped JavaScript options crossing the public boundary.
			expect(() => fixture(dir, timeout as number)).toThrow("DEADLINE_INVALID");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
