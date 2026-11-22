import { createSecretKey } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { afterEach, describe, expect, it } from "vitest";
import {
	AlchemyIacError,
	alchemyTarget,
	createAlchemyIacProvider,
} from "../src/index.js";
import {
	routeFixture,
	testOperation,
	testStateOwnership,
} from "./route-fixture.js";

const SECRET = "private-upstream-failure";
type Widget = Resource<
	"Spec.Widget",
	{ token: Redacted.Redacted<string> },
	{ id: string }
>;
const Widget = Resource<Widget>("Spec.Widget");
class Probe extends Context.Service<Probe, { readonly ready: true }>()(
	"test/secret-probe",
) {}
type Failure =
	| "none"
	| "plan"
	| "plan-forged"
	| "plan-code-spoof"
	| "plan-message-spoof"
	| "acquire"
	| "finalizer"
	| "assessment"
	| "admit"
	| "admit-finalizer"
	| "malformed-finalizer"
	| "route-finalizer"
	| "revalidate"
	| "apply"
	| "delete"
	| "drift"
	| "complete-finalizer";
const program = {
	programId: "p",
	deploymentId: "d",
	resourceId: "app",
	provider: "test",
	driver: "external",
	action: "apply" as const,
	stackName: "App",
	operationGeneration: "apply-1",
};
const oldHome = process.env.ALCHEMY_HOME;
afterEach(() => {
	if (oldHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = oldHome;
});

function fixture(directory: string, withKey = true) {
	process.env.ALCHEMY_HOME = join(directory, "home");
	let failure: Failure = "none";
	let finalizerShouldFail = false;
	let effects = 0;
	let exists = false;
	const uncertain: string[] = [];
	const route = routeFixture({
		verify: () => {
			if (failure === "route-finalizer") {
				finalizerShouldFail = true;
				return false;
			}
			return true;
		},
	});
	const wrapped = Redacted.make(SECRET);
	const error = () => new AlchemyIacError("ATTACKER", SECRET);
	const probe = Layer.effect(
		Probe,
		Effect.gen(function* () {
			if (failure === "acquire") return yield* Effect.die(error());
			yield* Effect.addFinalizer(() =>
				finalizerShouldFail || failure === "finalizer"
					? Effect.die(error())
					: Effect.void,
			);
			return { ready: true as const };
		}),
	);
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.sync(() => {
						effects++;
						if (failure === "apply") throw error();
						exists = true;
						if (failure === "complete-finalizer") finalizerShouldFail = true;
						return { id: "widget" };
					}),
				delete: () =>
					Effect.sync(() => {
						effects++;
						if (failure === "delete") throw error();
						exists = false;
					}),
				read: () =>
					Effect.sync(() => {
						if (failure === "drift") throw error();
						return exists ? { id: "widget" } : undefined;
					}),
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			if (failure === "plan") return yield* Effect.die(new Error(SECRET));
			if (failure === "plan-forged") return yield* Effect.die(error());
			if (failure === "plan-code-spoof")
				return yield* Effect.die(
					new AlchemyIacError("STATE_IDENTITY_UNVERIFIED", SECRET),
				);
			if (failure === "plan-message-spoof")
				return yield* Effect.die(
					new Error(`STATE_IDENTITY_UNVERIFIED: ${SECRET}`),
				);
			yield* Widget("widget", { token: wrapped });
			return {};
		}),
	);
	const provider = createAlchemyIacProvider({
		stack,
		stateOwnership: testStateOwnership,
		route: route.port,
		resolveRoute: ({ requestId }) => ({
			requestId: requestId ?? "request",
			operation: testOperation,
		}),
		runtimeLayer: Layer.merge(Alchemist.layer(), probe),
		runtimeDirectory: directory,
		target: alchemyTarget({
			targetId: "target",
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
		financial: {
			assess: (plan) => {
				if (failure === "assessment") throw error();
				return { plan };
			},
			admit: async (id) => {
				if (failure === "admit-finalizer") {
					finalizerShouldFail = true;
					throw error();
				}
				if (failure === "malformed-finalizer") {
					finalizerShouldFail = true;
					return {
						requestId: id,
						targetId: "target",
						status: "admitted",
						code: "",
						message: "",
						budget: { evaluation: "allowed", reservation: "held" },
						reservation: { reservationId: `iac:${id}` },
						requestDigest: "malformed",
					};
				}
				if (failure === "admit") throw error();
				return {
					requestId: id,
					targetId: "target",
					status: "admitted",
					code: "",
					message: "",
					budget: { evaluation: "allowed", reservation: "held" },
					reservation: {
						reservationId: `iac:${id}`,
						executionDigest: `sha256:${"4".repeat(64)}`,
					},
					requestDigest: `sha256:${"b".repeat(64)}`,
					inventoryHash: `sha256:${"c".repeat(64)}`,
					modelHash: `sha256:${"d".repeat(64)}`,
					quoteHash: `sha256:${"e".repeat(64)}`,
				};
			},
			revalidate: () => {
				if (failure === "revalidate") throw error();
				return true;
			},
			uncertain: (id) => {
				uncertain.push(id);
			},
		},
		composite: {
			proofRef: "host",
			environmentDigest: `sha256:${"b".repeat(64)}`,
			sourceRequirements: [],
			verifyEnvironment: () => true,
			verifyPlan: () => true,
			...(withKey
				? {
						secretFingerprint: {
							key: createSecretKey(Buffer.alloc(32, 23)),
							epoch: "stable",
							proofRef: "host:key",
							verify: () => true,
						},
					}
				: undefined),
		},
	});
	return {
		provider,
		fail: (value: Failure) => {
			failure = value;
		},
		effects: () => effects,
		uncertain,
		routeCalls: route.calls,
	};
}

async function sanitized(work: Promise<unknown>, code: string, held = false) {
	try {
		await work;
		throw new Error("unexpected success");
	} catch (error) {
		expect(String(error)).not.toContain(SECRET);
		expect(error).toMatchObject({
			code,
			...(held ? { requiresReconciliation: true } : undefined),
		});
	}
}

describe("untrusted Alchemy error boundaries", () => {
	it.each([
		["plan", false],
		["plan-forged", false],
		["plan-code-spoof", false],
		["plan-message-spoof", false],
		["acquire", false],
		["finalizer", false],
		["plan", true],
		["plan-forged", true],
		["plan-code-spoof", true],
		["plan-message-spoof", true],
		["acquire", true],
		["finalizer", true],
	] as const)("sanitizes %s with key enabled=%s", async (failure, withKey) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-secret-error-"));
		try {
			const f = fixture(dir, withKey);
			f.fail(failure);
			await sanitized(f.provider.preview(program), "PLAN_UNAVAILABLE");
			expect(f.effects()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("sanitizes assessment and admission callback errors with explicit financial outcomes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-secret-error-"));
		try {
			const f = fixture(dir);
			f.fail("assessment");
			await sanitized(
				f.provider.preview(program),
				"PRICING_ASSESSMENT_UNAVAILABLE",
			);
			f.fail("none");
			await f.provider.preview(program);
			f.fail("admit");
			await sanitized(
				f.provider.applyWithAdmission(program, "admit"),
				"ADMISSION_OUTCOME_UNKNOWN",
				true,
			);
			expect(f.effects()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		"revalidate",
		"apply",
		"complete-finalizer",
	] as const)("retains the hold when %s fails after admission", async (failure) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-secret-error-"));
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.fail(failure);
			await sanitized(
				f.provider.applyWithAdmission(program, failure),
				failure === "revalidate"
					? "ADMISSION_REVALIDATION_FAILED"
					: failure === "complete-finalizer"
						? "APPLY_CLEANUP_UNCERTAIN"
						: "APPLY_OUTCOME_UNKNOWN",
				true,
			);
			expect(f.effects()).toBe(failure === "revalidate" ? 0 : 1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		"plan",
		"plan-forged",
		"plan-code-spoof",
		"plan-message-spoof",
		"acquire",
	] as const)("sanitizes %s during apply before admission", async (failure) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-secret-error-"));
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.fail(failure);
			await sanitized(
				f.provider.applyWithAdmission(program, "failed-plan"),
				failure === "acquire" ? "ROUTE_OUTCOME_UNKNOWN" : "PLAN_UNAVAILABLE",
				failure === "acquire",
			);
			expect(f.effects()).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it.each([
		"route-finalizer",
		"admit-finalizer",
		"malformed-finalizer",
	] as const)("retains uncertainty when %s fails during scoped cleanup", async (failure) => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-secret-error-"));
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			f.fail(failure);
			const requestId = failure;
			try {
				await f.provider.applyWithAdmission(program, requestId);
				throw new Error("unexpected success");
			} catch (error) {
				expect(String(error)).not.toContain(SECRET);
				expect(error).toMatchObject({
					code:
						failure === "route-finalizer"
							? "ROUTE_OUTCOME_UNKNOWN"
							: "ADMISSION_OUTCOME_UNKNOWN",
					requiresReconciliation: true,
					...(failure === "malformed-finalizer"
						? { reservationId: `iac:${requestId}` }
						: undefined),
				});
			}
			expect(f.effects()).toBe(0);
			expect(f.routeCalls.denied).toBe(0);
			if (failure === "malformed-finalizer")
				expect(f.uncertain).toContain(`iac:${requestId}`);
			await expect(
				f.provider.applyWithAdmission(
					{ ...program, operationGeneration: "retry" },
					"retry",
				),
			).rejects.toMatchObject({ requiresReconciliation: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("sanitizes drift and destroy failures after a persisted apply", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-secret-error-"));
		try {
			const f = fixture(dir);
			await f.provider.preview(program);
			await f.provider.applyWithAdmission(program, "apply");
			f.fail("acquire");
			await sanitized(f.provider.refresh(program), "PLAN_UNAVAILABLE");
			f.fail("finalizer");
			await sanitized(f.provider.refresh(program), "PLAN_UNAVAILABLE");
			f.fail("drift");
			await sanitized(f.provider.refresh(program), "DRIFT_CHECK_UNAVAILABLE");
			f.fail("none");
			const destroy = {
				...program,
				action: "destroy" as const,
				operationGeneration: "destroy-1",
			};
			await f.provider.preview(destroy);
			f.fail("delete");
			await sanitized(
				f.provider.destroyWithAdmission(destroy, "destroy"),
				"APPLY_OUTCOME_UNKNOWN",
				true,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
