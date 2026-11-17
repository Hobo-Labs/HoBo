import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import type {
	FinancialDecision,
	FinancialPlan,
	IacRoutePort,
	UnpricedScopeProof,
} from "../src/port.js";
import { routeFixture } from "./route-fixture.js";

type Widget = Resource<"Spec.Widget", object, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
interface FixtureReservation {
	reservationId: string;
	unboundedExposure?: boolean;
	unpricedScopeProof?: UnpricedScopeProof;
}
const dirs: string[] = [];
const priorHome = process.env.ALCHEMY_HOME;

afterEach(() => {
	if (priorHome === undefined) delete process.env.ALCHEMY_HOME;
	else process.env.ALCHEMY_HOME = priorHome;
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function fixture(
	decision: (requestId: string) => object,
	revalidate: (
		admission: FinancialDecision,
		plan: FinancialPlan,
	) => boolean | Promise<boolean> = () => true,
	targetId = "target",
	defaultRequestId: string | null = "logical-attempt",
	route: IacRoutePort | undefined = routeFixture().port,
) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-alchemy-financial-"));
	dirs.push(dir);
	process.env.ALCHEMY_HOME = join(dir, "auth");
	let applies = 0;
	let admissions = 0;
	const uncertain: string[] = [];
	const stack = Stack(
		"App",
		{
			providers: Provider.succeed(Widget, {
				reconcile: () =>
					Effect.sync(() => {
						applies++;
						return { id: "widget" };
					}),
				delete: () => Effect.void,
			}),
			state: inMemoryState(),
		},
		Effect.gen(function* () {
			yield* Widget("widget", {});
			return { output: "ok" };
		}),
	);
	const provider = createAlchemyIacProvider({
		stack,
		runtimeLayer: Alchemist.layer(),
		runtimeDirectory: join(dir, "runtime"),
		defaultRequestId: defaultRequestId ?? undefined,
		route,
		target: alchemyTarget({
			targetId,
			tenantId: "tenant",
			stackName: "App",
			stage: "test",
			programResourceId: "app",
			sourceDigest: `sha256:${"a".repeat(64)}`,
			inventoryEvidenceRef: "inventory:1",
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
			assess: (plan) => ({ plan }),
			admit: async (requestId) => {
				admissions++;
				// SAFETY: this boundary intentionally tests malformed provider receipts.
				return decision(requestId) as never;
			},
			revalidate,
			uncertain: (id) => {
				uncertain.push(id);
			},
		},
	});
	return {
		provider,
		applies: () => applies,
		admissions: () => admissions,
		uncertain,
		program: {
			programId: "p",
			deploymentId: "d",
			resourceId: "app",
			provider: "test",
			driver: "external",
			action: "apply" as const,
			stackName: "App",
		},
	};
}

function admitted(
	requestId: string,
	evaluation: string,
	unboundedExposure?: boolean,
) {
	const reservation: FixtureReservation = {
		reservationId: `iac:${requestId}`,
	};
	if (unboundedExposure !== undefined)
		reservation.unboundedExposure = unboundedExposure;
	if (unboundedExposure === true)
		reservation.unpricedScopeProof = {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "period",
				policyRevision: "r1",
			},
			providerAccountIds: ["account"],
			authorityRef: "host:finance",
			evidenceRef: "scope:proof",
			ownershipEpoch: "1",
			observedAt: "2026-01-01T00:00:00Z",
			exclusiveUntilSettled: true,
			noSharedEntitlements: true,
			signature: "signature",
		};
	return {
		requestId,
		targetId: "target",
		status: "admitted",
		code: "",
		message: "",
		requestDigest: `sha256:${"b".repeat(64)}`,
		inventoryHash: `sha256:${"c".repeat(64)}`,
		modelHash: evaluation === "allowed" ? `sha256:${"d".repeat(64)}` : "",
		quoteHash: evaluation === "allowed" ? `sha256:${"e".repeat(64)}` : "",
		unpricedPolicyProof: {
			requestDigest: `sha256:${"b".repeat(64)}`,
			inventoryHash: `sha256:${"c".repeat(64)}`,
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "period",
				policyRevision: "r1",
			},
			policyHash: "sha256:policy",
			effect: "allow",
			evidenceRef: "host:policy",
			obligationsSatisfied: true,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: "2027-01-01T00:00:00Z",
		},
		budget: { evaluation, reservation: "held" },
		reservation,
	};
}

describe("financial admission modes", () => {
	it("snapshots the requested operation before asynchronous planning", async () => {
		const f = fixture((id) => admitted(id, "allowed", false));
		const program = { ...f.program };
		const pending = f.provider.assessPricing(program);
		Object.assign(program, { action: "destroy" });
		const assessment = await pending;
		expect(assessment.plan.operation).toBe("deploy");
	});

	it("checks and executes the same snapshotted operation", async () => {
		const f = fixture((id) => admitted(id, "allowed", false));
		await f.provider.preview(f.program);
		let actionReads = 0;
		const program = {
			...f.program,
			get action(): "apply" | "destroy" {
				actionReads++;
				return actionReads === 1 ? "apply" : "destroy";
			},
		};
		await f.provider.applyWithAdmission(program, "attempt");
		expect(actionReads).toBe(1);
		expect(f.applies()).toBe(1);
	});

	it("rejects malformed wire proofs even though their fields accept protobuf values", async () => {
		const f = fixture((id) => {
			const valid = admitted(id, "bypassed", true);
			const wire: FinancialDecision = {
				...valid,
				unpricedPolicyProof: {
					requestDigest: valid.requestDigest,
					inventoryHash: valid.inventoryHash,
					policyHash: "policy",
					effect: "deny",
					evidenceRef: "policy:evidence",
					obligationsSatisfied: false,
					observedAt: "2026-01-01T00:00:00Z",
					validUntil: "2027-01-01T00:00:00Z",
				},
			};
			return wire;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("requires a stable request ID before claiming a route", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			null,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(f.provider.apply(f.program)).rejects.toMatchObject({
			code: "REQUEST_ID_REQUIRED",
			requiresReconciliation: false,
		});
		expect(route.calls.direct).toBe(0);
		expect(f.admissions()).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it.each([
		"reused",
		"lost acknowledgment",
	] as const)("does not admit a route permit with %s consumption", async (failure) => {
		const route = routeFixture({
			consume: () => {
				if (failure === "lost acknowledgment") throw new Error("lost");
				return false;
			},
		});
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_PERMIT_UNVERIFIED",
			requiresReconciliation: true,
		});
		expect(route.calls.consumed).toBe(1);
		expect(route.calls.denied).toBe(0);
		expect(f.admissions()).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("retains the hold if the route is no longer active before provider start", async () => {
		let verifications = 0;
		const route = routeFixture({ verify: () => ++verifications === 1 });
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_PERMIT_UNVERIFIED",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(route.calls.consumed).toBe(1);
		expect(route.calls.verified).toBe(2);
		expect(f.admissions()).toBe(1);
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("uses a dispatched permit without acquiring a second route", async () => {
		const route = routeFixture();
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		const attemptId = "A".repeat(43);
		const result = await f.provider.applyWithAdmission(
			f.program,
			"attempt",
			undefined,
			{
				tenantId: "tenant",
				requestId: "attempt",
				targetId: "target",
				inventoryHash: `sha256:${"c".repeat(64)}`,
				attemptId,
			},
		);
		expect(route.calls.direct).toBe(0);
		expect(route.calls.consumed).toBe(1);
		expect(route.calls.verified).toBe(2);
		expect(f.applies()).toBe(1);
		expect(JSON.stringify(result)).not.toContain(attemptId);
	});

	it("only admits one of two adapters racing the same dispatched permit", async () => {
		let consumed = false;
		const route = routeFixture({
			consume: () => {
				if (consumed) return false;
				consumed = true;
				return true;
			},
		});
		const first = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		const second = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await Promise.all([
			first.provider.preview(first.program),
			second.provider.preview(second.program),
		]);
		const permit = {
			tenantId: "tenant",
			requestId: "attempt",
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
			attemptId: "A".repeat(43),
		};
		const outcomes = await Promise.allSettled([
			first.provider.applyWithAdmission(
				first.program,
				"attempt",
				undefined,
				permit,
			),
			second.provider.applyWithAdmission(
				second.program,
				"attempt",
				undefined,
				permit,
			),
		]);
		expect(
			outcomes.filter((outcome) => outcome.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			outcomes.filter((outcome) => outcome.status === "rejected"),
		).toHaveLength(1);
		expect(first.admissions() + second.admissions()).toBe(1);
		expect(first.applies() + second.applies()).toBe(1);
	});

	it("retains a successful hold when durable route completion is unknown", async () => {
		const route = routeFixture({ loseCompletion: true });
		const f = fixture(
			(id) => admitted(id, "allowed", false),
			undefined,
			undefined,
			undefined,
			route.port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ROUTE_OUTCOME_UNKNOWN",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(f.applies()).toBe(1);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("uses the host's stable request ID across candidate targets", async () => {
		const seen: string[] = [];
		const deny = (targetId: string) => (requestId: string) => {
			seen.push(requestId);
			return {
				requestId,
				targetId,
				status: "denied",
				code: "NOT_ALLOWED",
				message: "denied",
				budget: { evaluation: "denied", reservation: "not-created" },
			};
		};
		const first = fixture(deny("target-a"), undefined, "target-a");
		const second = fixture(deny("target-b"), undefined, "target-b");
		const firstProgram = {
			...first.program,
			provider: "provider-a",
			driver: "driver-a",
		};
		const secondProgram = {
			...second.program,
			provider: "provider-b",
			driver: "driver-b",
		};
		await first.provider.preview(firstProgram);
		await second.provider.preview(secondProgram);
		await expect(first.provider.apply(firstProgram)).rejects.toMatchObject({
			code: "NOT_ALLOWED",
		});
		await expect(second.provider.apply(secondProgram)).rejects.toMatchObject({
			code: "NOT_ALLOWED",
		});
		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(seen[1]);
	});

	it("executes an explicitly authorized unbounded exposure and discloses the budget bypass", async () => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(f.program, "attempt");
		expect(result).toMatchObject({
			outputs: { output: "ok" },
			admission: {
				budget: { evaluation: "bypassed", reservation: "held" },
				reservation: { reservationId: "iac:attempt", unboundedExposure: true },
				unpricedPolicyProof: {
					identity: { tenantId: "tenant" },
					effect: "allow",
					evidenceRef: "host:policy",
				},
			},
		});
		expect(f.applies()).toBe(1);
	});

	it.each([
		["bypassed", undefined],
		["bypassed", false],
		["allowed", true],
	] as const)("refuses a mismatched %s admission marker", async (evaluation, unboundedExposure) => {
		const f = fixture((id) => admitted(id, evaluation, unboundedExposure));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("does not silently replace a ranked priced expectation with a bypassed decision", async () => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", {
				targetId: "target",
				inventoryHash: `sha256:${"c".repeat(64)}`,
				modelHash: `sha256:${"b".repeat(64)}`,
				quoteHash: `sha256:${"c".repeat(64)}`,
			}),
		).rejects.toMatchObject({
			code: "ADMISSION_QUOTE_MISMATCH",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("pins the reviewed expectation before invoking the financial authority", async () => {
		const expected = {
			kind: "unpriced" as const,
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
		};
		const f = fixture((id) => {
			expected.inventoryHash = `sha256:${"d".repeat(64)}`;
			return admitted(id, "bypassed", true);
		});
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(
			f.program,
			"attempt",
			expected,
		);
		expect(result.admission.budget.evaluation).toBe("bypassed");
		expect(f.applies()).toBe(1);
	});

	it.each([
		{
			kind: "unknown",
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
		},
		{ kind: "unpriced", targetId: "target", inventoryHash: "not-a-digest" },
		{
			kind: "unpriced",
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
			quoteHash: `sha256:${"a".repeat(64)}`,
		},
	])("rejects a malformed routing expectation before admission", async (expected) => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		// SAFETY: malformed expectations exercise the public runtime boundary.
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", expected as never),
		).rejects.toMatchObject({
			code: "EXPECTATION_INVALID",
			requiresReconciliation: false,
		});
		expect(f.admissions()).toBe(0);
		expect(f.applies()).toBe(0);
	});

	it("accepts an explicitly selected unpriced target only with its reviewed inventory", async () => {
		const f = fixture((id) => admitted(id, "bypassed", true));
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(f.program, "attempt", {
			kind: "unpriced",
			targetId: "target",
			inventoryHash: `sha256:${"c".repeat(64)}`,
		});
		expect(result.admission.budget.evaluation).toBe("bypassed");
		expect(f.applies()).toBe(1);
	});

	it.each([
		"changed-inventory",
		"changed-mode",
	] as const)("refuses an unpriced expectation with %s", async (reason) => {
		const f = fixture(
			(id) =>
				admitted(
					id,
					reason === "changed-mode" ? "allowed" : "bypassed",
					reason !== "changed-mode",
				),
			undefined,
			undefined,
			undefined,
			routeFixture({
				inventoryHash: `sha256:${(reason === "changed-inventory" ? "d" : "c").repeat(64)}`,
			}).port,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", {
				kind: "unpriced",
				targetId: "target",
				inventoryHash: `sha256:${(reason === "changed-inventory" ? "d" : "c").repeat(64)}`,
			}),
		).rejects.toMatchObject({
			code:
				reason === "changed-inventory"
					? "ROUTE_INVENTORY_MISMATCH"
					: "ADMISSION_QUOTE_MISMATCH",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"requestDigest",
		"inventoryHash",
		"modelHash",
		"quoteHash",
	] as const)("refuses a bypass receipt with invalid %s evidence", async (field) => {
		const f = fixture((id) => ({
			...admitted(id, "bypassed", true),
			[field]:
				field.endsWith("Digest") || field === "inventoryHash"
					? "invalid"
					: `sha256:${"d".repeat(64)}`,
		}));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("refuses an unbounded admission whose policy proof is for another tenant", async () => {
		const f = fixture((id) => {
			const decision = admitted(id, "bypassed", true);
			decision.unpricedPolicyProof.identity.tenantId = "other";
			return decision;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"foreign-account",
		"foreign-policy",
		"duplicate-account",
	] as const)("refuses unbounded scope proof with %s", async (reason) => {
		const f = fixture((id) => {
			const decision = admitted(id, "bypassed", true);
			const scope = decision.reservation.unpricedScopeProof;
			if (scope === undefined) throw new Error("scope fixture missing");
			if (reason === "foreign-account")
				Object.assign(scope, { providerAccountIds: ["other"] });
			if (reason === "duplicate-account")
				Object.assign(scope, { providerAccountIds: ["account", "account"] });
			if (reason === "foreign-policy")
				Object.assign(scope.identity, { policyRevision: "foreign" });
			return decision;
		});
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"allowed",
		"bypassed",
	] as const)("retains the %s hold when authority revalidation fails", async (mode) => {
		const f = fixture(
			(id) => admitted(id, mode, mode === "bypassed"),
			() => false,
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_REVALIDATION_FAILED",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it("does not expose mutable admission data to the authority verifier", async () => {
		const f = fixture(
			(id) => admitted(id, "bypassed", true),
			(copy) => {
				if (copy.reservation !== undefined)
					copy.reservation.reservationId = "tampered";
				return true;
			},
		);
		await f.provider.preview(f.program);
		const result = await f.provider.applyWithAdmission(f.program, "attempt");
		expect(result.admission.reservation.reservationId).toBe("iac:attempt");
		expect(f.applies()).toBe(1);
	});

	it("treats a lost revalidation response as unresolved and blocks retry", async () => {
		const f = fixture(
			(id) => admitted(id, "bypassed", true),
			() => {
				throw new Error("response lost");
			},
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_REVALIDATION_FAILED",
			requiresReconciliation: true,
			reservationId: "iac:attempt",
		});
		await expect(
			f.provider.applyWithAdmission(f.program, "retry"),
		).rejects.toMatchObject({
			code: "EXECUTION_ALREADY_CLAIMED",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});

	it.each([
		"requestDigest",
		"inventoryHash",
		"modelHash",
		"quoteHash",
	] as const)("refuses a priced direct apply without valid %s", async (field) => {
		const f = fixture((id) => ({
			...admitted(id, "allowed", false),
			[field]: "",
		}));
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt"),
		).rejects.toMatchObject({
			code: "ADMISSION_RECEIPT_INVALID",
			requiresReconciliation: true,
		});
		expect(f.applies()).toBe(0);
		expect(f.uncertain).toEqual(["iac:attempt"]);
	});
});
