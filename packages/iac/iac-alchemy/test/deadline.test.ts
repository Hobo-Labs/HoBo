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

function fixture(directory: string, timeout = 50) {
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
	const provider = createAlchemyIacProvider({
		stack,
		stateOwnership: {
			backendRef: "test:state",
			ownershipEpoch: "test:epoch",
			verify: async ({ phase }) => {
				ownershipCalls++;
				if (phase === "plan") ownershipPlans++;
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
			if (block === "resolve") {
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
			assess: (plan: FinancialPlan) => ({ plan }),
			admit: async (requestId) => {
				admissions++;
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
				if (block === "revalidate") {
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
		denyPlan: () => {
			planAllowed = false;
		},
		block: (phase: typeof block) => {
			block = phase;
			ownershipPlans = 0;
		},
		observed: () => ({
			effects,
			plans,
			stateReads,
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
	await vi.advanceTimersByTimeAsync(51);
}

describe("bounded Alchemy execution deadlines", () => {
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
			const f = fixture(dir);
			f.block("ownership-plan-all");
			// Each request has an independent host callback, all of which remain
			// pending even after the adapter's response timer has fired.
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
			await expire();
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
			const result = expect(
				f.provider.applyWithAdmission(program, "request"),
			).rejects.toMatchObject({
				code: "EXECUTION_DEADLINE_AFTER_ADMISSION",
				requiresReconciliation: true,
			});
			await f.started.promise;
			await expire();
			await result;
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
			// SAFETY: exercise untyped JavaScript options crossing the public boundary.
			expect(() => fixture(dir, timeout as number)).toThrow("DEADLINE_INVALID");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
