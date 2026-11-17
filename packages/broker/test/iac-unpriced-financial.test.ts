import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	createTargetPricingInventory,
	targetPricingUnavailable,
} from "@hobo/pricing";
import { afterEach, describe, expect, it } from "vitest";
import {
	makeScenario,
	perUnitCharge,
	usage,
	workload,
} from "../../pricing/test/fixtures.js";
import {
	admitUnpricedIacTarget,
	type BudgetIdentity,
	BudgetLedgerSnapshotSchema,
	createIacFinancialServices,
	createSqliteBudgetAdmissionAuthority,
	IacUnpricedPolicyProofSchema,
	IacUnpricedScopeProofSchema,
} from "../src/index.js";

const now = "2026-01-02T00:00:00Z";
const end = "2026-01-31T00:00:00Z";
const directories: string[] = [];
afterEach(() => {
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-unpriced-service-"));
	directories.push(dir);
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		now: () => now,
		unpricedScopeTrust: {
			verify: (proof) => proof.signature === "scope-signature",
			isCurrent: (proof) => proof.signature === "scope-signature",
			settlement: () => false,
		},
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "2026-01",
				policyRevision: "r1",
			},
			limitMicros: 3_000_000,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: end,
			providerAccounts: [
				{ providerAccountId: "account", limitMicros: 3_000_000 },
			],
		}),
	});
	const plan = {
		targetId: "yard",
		tenantId: "tenant",
		planDigest: `sha256:${"a".repeat(64)}`,
		operation: "deploy",
		evidenceRef: "inventory:1",
		resources: [
			{
				resourceId: "worker",
				providerId: "provider",
				providerAccountRef: "account",
				productId: "compute",
			},
		],
	};
	const authorize = (input: {
		requestDigest: string;
		inventoryHash: string;
		identity: BudgetIdentity;
	}) => ({
		gate: { effect: "allow" as const, reasons: [], events: [] },
		proof: create(IacUnpricedPolicyProofSchema, {
			requestDigest: input.requestDigest,
			inventoryHash: input.inventoryHash,
			identity: input.identity,
			policyHash: "policy:1",
			effect: "allow",
			evidenceRef: "unpriced-approval:1",
			obligationsSatisfied: true,
			observedAt: "2026-01-01T00:00:00Z",
			validUntil: end,
		}),
		scopeProof: create(IacUnpricedScopeProofSchema, {
			identity: input.identity,
			providerAccountIds: ["account"],
			authorityRef: "scope-authority",
			evidenceRef: "exclusive:1",
			ownershipEpoch: "epoch:1",
			observedAt: "2026-01-01T00:00:00Z",
			exclusiveUntilSettled: true,
			noSharedEntitlements: true,
			signature: "scope-signature",
		}),
	});
	return { authority, plan, authorize };
}

describe("policy-directed unpriced IaC admission", () => {
	it.each([
		"surcharge",
		"undefined",
		"sparse-array",
		"array-property",
	])("does not bypass budget when the declared model contains %s", (kind) => {
		const { authority, authorize } = fixture();
		try {
			const scenario = makeScenario({
				charges: [perUnitCharge("runtime", "minute", "0.25")],
				candidate: [workload("agreement", [usage("minute", "4", "minute")])],
			});
			const charges = scenario.catalog?.rateCards[0]?.charges;
			const charge = charges?.[0];
			if (!charges || !charge) throw new Error("charge missing");
			if (kind === "surcharge")
				Object.defineProperty(charge, "surcharge", {
					value: "100",
					enumerable: true,
				});
			if (kind === "undefined")
				Object.defineProperty(charge, "unknown", {
					value: undefined,
					enumerable: true,
				});
			if (kind === "sparse-array") charges.length = 2;
			if (kind === "array-property")
				Object.defineProperty(charges, "extra", {
					value: "fee",
					enumerable: true,
				});
			let calls = 0;
			expect(() =>
				createIacFinancialServices({
					authority,
					now: () => now,
					pricing: {
						modelId: "terms",
						revision: "1",
						scenario,
						bindings: [{ resourceId: "worker", candidateIndex: 0 }],
					},
					unpriced: {
						authorize: (input) => {
							calls++;
							return authorize(input);
						},
					},
				}),
			).toThrow();
			expect(calls).toBe(0);
			expect(authority.read(now).unboundedExposureCount).toBe(0);
		} finally {
			authority.close();
		}
	});

	it("does not authorize a malformed explicit unavailable state", async () => {
		const { authority, plan, authorize } = fixture();
		try {
			const inventory = createTargetPricingInventory({
				...plan,
				complete: true,
			});
			const pricing = targetPricingUnavailable("no model");
			if (pricing.state.case !== "unavailable")
				throw new Error("unavailable missing");
			Object.defineProperty(pricing.state.value, "fee", {
				value: "100",
				enumerable: true,
			});
			let calls = 0;
			expect(
				await admitUnpricedIacTarget(
					{ requestId: "bad", inventory, pricing },
					{
						authority,
						now: () => now,
						authorizeUnpriced: (input) => {
							calls++;
							return authorize(input);
						},
					},
				),
			).toMatchObject({
				status: "denied",
				code: "PRICING_INPUT_INVALID",
				budget: { reservation: "not-created" },
			});
			expect(calls).toBe(0);
			expect(authority.read(now).unboundedExposureCount).toBe(0);
		} finally {
			authority.close();
		}
	});
	it("exposes unknown pricing and refuses execution by default", async () => {
		const { authority, plan } = fixture();
		const financial = createIacFinancialServices({ authority, now: () => now });
		expect(financial.assess(plan).quote).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_UNAVAILABLE",
		});
		expect(await financial.admit("attempt", plan)).toMatchObject({
			status: "denied",
			code: "PRICING_MODEL_UNAVAILABLE",
			budget: { evaluation: "unavailable", reservation: "not-created" },
		});
		expect(authority.read(now).unboundedExposureCount).toBe(0);
		authority.close();
	});

	it("requires explicit policy and creates a durable unbounded claim rather than a quote", async () => {
		const { authority, plan, authorize } = fixture();
		const financial = createIacFinancialServices({
			authority,
			now: () => now,
			unpriced: { authorize },
		});
		const admission = await financial.admit("attempt", plan);
		expect(admission).toMatchObject({
			requestId: "attempt",
			targetId: "yard",
			status: "admitted",
			budget: { evaluation: "bypassed", reservation: "held" },
			reservation: {
				reservationId: "iac:attempt",
				unboundedExposure: true,
				quoteId: "",
			},
		});
		expect(admission.inventoryHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(admission.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(admission.modelHash).toBe("");
		expect(admission.quoteHash).toBe("");
		expect(admission.quote).toBeUndefined();
		expect(authority.read(now).unboundedExposureCount).toBe(1);
		expect(await financial.revalidate(admission, plan)).toBe(true);
		for (const value of [
			false,
			undefined,
			null,
			"true",
			1,
			{},
			Promise.resolve("true"),
		]) {
			const bad = createIacFinancialServices({
				authority: {
					...authority,
					// SAFETY: model a malformed JavaScript authority at the trust boundary.
					revalidateUnbounded: () => value as never,
				},
				now: () => now,
				unpriced: { authorize },
			});
			expect(await bad.revalidate(admission, plan)).toBe(false);
			expect(authority.read(now).unboundedExposureCount).toBe(1);
		}
		expect(
			await financial.revalidate(admission, {
				...plan,
				planDigest: `sha256:${"f".repeat(64)}`,
			}),
		).toBe(false);
		expect(await financial.admit("attempt", plan)).toMatchObject({
			status: "replay",
			code: "EXECUTION_ALREADY_CLAIMED",
			budget: { evaluation: "bypassed", reservation: "held" },
		});
		authority.close();
	});

	it.each([
		"missing-gate",
		"truthy-obligation",
		"unknown-proof",
		"unknown-scope",
		"accessor",
	])("rejects malformed unpriced policy decisions (%s) before claiming exposure", async (kind) => {
		const { authority, plan, authorize } = fixture();
		try {
			let getters = 0;
			const financial = createIacFinancialServices({
				authority,
				now: () => now,
				unpriced: {
					authorize: async (input) => {
						const decision = authorize(input);
						if (kind === "missing-gate")
							Object.defineProperty(decision, "gate", { value: undefined });
						if (kind === "truthy-obligation")
							Object.defineProperty(decision.proof, "obligationsSatisfied", {
								value: "yes",
							});
						if (kind === "unknown-proof")
							Object.defineProperty(decision.proof, "unfulfilledObligation", {
								value: true,
								enumerable: true,
							});
						if (kind === "unknown-scope")
							Object.defineProperty(decision.scopeProof, "sharedAccount", {
								value: true,
								enumerable: true,
							});
						if (kind === "accessor")
							Object.defineProperty(decision, "proof", {
								enumerable: true,
								get: () => {
									getters++;
									return undefined;
								},
							});
						return decision;
					},
				},
			});
			expect(await financial.admit("bad-policy", plan)).toMatchObject({
				status: "denied",
				code: "UNPRICED_POLICY_UNAVAILABLE",
				budget: { reservation: "not-created" },
			});
			expect(getters).toBe(0);
			expect(authority.read(now).unboundedExposureCount).toBe(0);
		} finally {
			authority.close();
		}
	});

	it("fails revalidation after the budget policy revision changes", async () => {
		const { authority, plan, authorize } = fixture();
		const financial = createIacFinancialServices({
			authority,
			now: () => now,
			unpriced: { authorize },
		});
		const admission = await financial.admit("attempt", plan);
		expect(await financial.revalidate(admission, plan)).toBe(true);
		const updated = authority.read(now);
		if (!updated.identity) throw new Error("identity missing");
		updated.identity.policyRevision = "r2";
		authority.configure(updated, updated.seq, now);
		expect(await financial.revalidate(admission, plan)).toBe(false);
		expect(authority.read(now).unboundedExposureCount).toBe(1);
		authority.close();
	});

	it("denies unpriced policy rejection and mismatched proofs without claiming an execution", async () => {
		const { authority, plan, authorize } = fixture();
		for (const kind of [
			"deny",
			"approval",
			"missing-obligations",
			"wrong-inventory",
			"expired",
		] as const) {
			const financial = createIacFinancialServices({
				authority,
				now: () => now,
				unpriced: {
					authorize: (input) => {
						const decision = authorize(input);
						if (kind === "deny") decision.proof.effect = "deny";
						if (kind === "approval") decision.proof.effect = "require-approval";
						if (kind === "missing-obligations")
							decision.proof.obligationsSatisfied = false;
						if (kind === "wrong-inventory")
							decision.proof.inventoryHash = `sha256:${"f".repeat(64)}`;
						if (kind === "expired") decision.proof.validUntil = now;
						return decision;
					},
				},
			});
			expect(await financial.admit(kind, plan)).toMatchObject({
				status: "denied",
			});
		}
		expect(authority.read(now).unboundedExposureCount).toBe(0);
		authority.close();
	});

	it("never authorizes two concurrent executions of the same unpriced request", async () => {
		const { authority, plan, authorize } = fixture();
		const financial = createIacFinancialServices({
			authority,
			now: () => now,
			unpriced: { authorize },
		});
		const decisions = await Promise.all([
			financial.admit("attempt", plan),
			financial.admit("attempt", plan),
		]);
		expect(
			decisions.filter((decision) => decision.status === "admitted"),
		).toHaveLength(1);
		expect(
			decisions.filter((decision) => decision.status !== "admitted")[0]?.status,
		).toMatch(/^(replay|uncertain)$/u);
		expect(authority.read(now).unboundedExposureCount).toBe(1);
		authority.close();
	});

	it("retains unknown exposure if a reservation acknowledgment is lost", async () => {
		const { authority, plan, authorize } = fixture();
		const financial = createIacFinancialServices({
			authority: {
				...authority,
				reserveUnbounded(input) {
					authority.reserveUnbounded(input);
					throw new Error("lost acknowledgment");
				},
			},
			now: () => now,
			unpriced: { authorize },
		});
		expect(await financial.admit("attempt", plan)).toMatchObject({
			status: "uncertain",
			code: "UNPRICED_RESERVATION_OUTCOME_UNKNOWN",
			budget: { evaluation: "unavailable", reservation: "unknown" },
		});
		expect(authority.read(now).unboundedExposureCount).toBe(1);
		expect(authority.lookup("iac:attempt")?.executionDigest).toBe("");
		authority.close();
	});

	it("does not reinterpret a ranked priced expectation as unpriced permission", async () => {
		const { authority, plan, authorize } = fixture();
		let called = false;
		const financial = createIacFinancialServices({
			authority,
			now: () => now,
			unpriced: {
				authorize: (input) => {
					called = true;
					return authorize(input);
				},
			},
		});
		expect(
			await financial.admit("attempt", plan, {
				targetId: "yard",
				inventoryHash: `sha256:${"1".repeat(64)}`,
				modelHash: `sha256:${"2".repeat(64)}`,
				quoteHash: `sha256:${"3".repeat(64)}`,
			}),
		).toMatchObject({ status: "denied", code: "ROUTING_QUOTE_CHANGED" });
		expect(called).toBe(false);
		authority.close();
	});
});
