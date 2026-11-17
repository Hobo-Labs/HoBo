import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inMemoryState, Resource, Stack } from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";
import { alchemyTarget, createAlchemyIacProvider } from "../src/index.js";
import type { FinancialDecision, FinancialPlan } from "../src/port.js";

type Widget = Resource<"Spec.Widget", object, { id: string }>;
const Widget = Resource<Widget>("Spec.Widget");
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
			assess: () => ({}),
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
	const reservation: NonNullable<FinancialDecision["reservation"]> = {
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
	it("uses one target-independent default request ID for the same logical operation", async () => {
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
				inventoryHash: `sha256:${"a".repeat(64)}`,
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
		const f = fixture((id) =>
			admitted(
				id,
				reason === "changed-mode" ? "allowed" : "bypassed",
				reason !== "changed-mode",
			),
		);
		await f.provider.preview(f.program);
		await expect(
			f.provider.applyWithAdmission(f.program, "attempt", {
				kind: "unpriced",
				targetId: "target",
				inventoryHash: `sha256:${(reason === "changed-inventory" ? "d" : "c").repeat(64)}`,
			}),
		).rejects.toMatchObject({
			code: "ADMISSION_QUOTE_MISMATCH",
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
