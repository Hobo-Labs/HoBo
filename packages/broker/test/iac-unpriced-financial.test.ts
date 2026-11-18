import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	createTargetPricingInventory,
	targetPricingUnavailable,
} from "@hobo/pricing";
import { afterEach, describe, expect, it, vi } from "vitest";
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
	it("requires explicit unpriced policy for a destroy without a model", async () => {
		const { authority, plan, authorize } = fixture();
		try {
			plan.operation = "destroy";
			const financial = createIacFinancialServices({
				authority,
				now: () => now,
				unpriced: { authorize },
			});
			expect(financial.assess(plan)).toMatchObject({
				quote: { ok: false, code: "PRICING_MODEL_UNAVAILABLE" },
				admissionPath: { kind: "unpriced-policy" },
			});
			expect(await financial.admit("destroy-unpriced", plan)).toMatchObject({
				status: "admitted",
				budget: { evaluation: "bypassed", reservation: "held" },
				reservation: { unboundedExposure: true },
			});
			expect(authority.read(now).unboundedExposureCount).toBe(1);
		} finally {
			authority.close();
		}
	});

	it("pins the optional unpriced host and expectation across an in-flight authorization", async () => {
		const { authority, plan, authorize } = fixture();
		const { authority: alternate } = fixture();
		const originalPlan = structuredClone(plan);
		let entered = () => {};
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let release = () => {};
		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});
		const unpriced = {
			async authorize(input: Parameters<typeof authorize>[0]) {
				expect(this).not.toBe(unpriced);
				expect(Object.isFrozen(this)).toBe(true);
				entered();
				await waiting;
				expect(this.authorize).not.toBe(unpriced.authorize);
				return authorize(input);
			},
		};
		const options = {
			authority,
			now() {
				expect(this.authority).toBe(authority);
				expect(Object.isFrozen(this)).toBe(true);
				return now;
			},
			unpriced,
		};
		try {
			const financial = createIacFinancialServices(options);
			const assessment = financial.assess(plan);
			if (!assessment.inventoryHash) throw new Error("missing inventory hash");
			const expected = {
				kind: "unpriced" as const,
				targetId: plan.targetId,
				inventoryHash: assessment.inventoryHash,
			};
			const pending = financial.admit("captured-host", plan, expected);
			await started;
			options.authority = alternate;
			options.now = () => {
				throw new Error("substituted clock");
			};
			unpriced.authorize = async () => {
				throw new Error("substituted policy");
			};
			plan.targetId = "substituted";
			expected.inventoryHash = `sha256:${"f".repeat(64)}`;
			release();
			const admission = await pending;
			expect(admission).toMatchObject({
				status: "admitted",
				targetId: "yard",
				budget: { evaluation: "bypassed", reservation: "held" },
			});
			expect(authority.read(now).unboundedExposureCount).toBe(1);
			expect(alternate.read(now).unboundedExposureCount).toBe(0);
			expect(await financial.revalidate(admission, originalPlan)).toBe(true);
		} finally {
			release();
			authority.close();
			alternate.close();
		}
	});

	it("rejects malformed unpriced expectations before policy or budget work", async () => {
		const { authority, plan } = fixture();
		let traps = 0;
		let calls = 0;
		try {
			const financial = createIacFinancialServices({
				authority,
				now: () => now,
				unpriced: {
					authorize: () => {
						calls++;
						throw new Error("policy");
					},
				},
			});
			const assessment = financial.assess(plan);
			if (!assessment.inventoryHash) throw new Error("missing inventory hash");
			const valid = {
				kind: "unpriced",
				targetId: plan.targetId,
				inventoryHash: assessment.inventoryHash,
			};
			const proxy = new Proxy(valid, {
				get() {
					traps++;
					throw new Error("trap");
				},
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
			});
			const accessor = Object.defineProperty({ ...valid }, "targetId", {
				enumerable: true,
				get() {
					traps++;
					throw new Error("trap");
				},
			});
			for (const expected of [
				proxy,
				accessor,
				{ ...valid, unknownPolicy: true },
				{ ...valid, modelHash: "unexpected" },
				{ ...valid, [Symbol("unknown")]: true },
			]) {
				expect(
					// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed values deliberately exercise the expectation boundary.
					await financial.admit("bad-expectation", plan, expected as never),
				).toMatchObject({
					status: "denied",
					code: "REQUEST_INVALID",
					budget: { reservation: "not-created" },
				});
			}
			expect(traps).toBe(0);
			expect(calls).toBe(0);
			expect(authority.read(now).unboundedExposureCount).toBe(0);
		} finally {
			authority.close();
		}
	});
	/* oxlint-disable anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: intentionally malformed values test the external request boundary. */
	it("rejects inaccessible and malformed request data before invoking traps or authorities", async () => {
		let traps = 0;
		let authorityCalls = 0;
		const { plan } = fixture();
		const inventory = createTargetPricingInventory({ ...plan, complete: true });
		const pricing = targetPricingUnavailable("no model");
		const valid = { requestId: "request", inventory, pricing };
		const proxy = (value: object) =>
			new Proxy(value, {
				get() {
					traps++;
					throw new Error("trap");
				},
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("trap");
				},
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
			});
		const accessor = (key: string) =>
			Object.defineProperty({ ...valid }, key, {
				enumerable: true,
				get() {
					traps++;
					throw new Error("trap");
				},
			});
		const deps = {
			get authority() {
				authorityCalls++;
				throw new Error("authority");
			},
			now: () => {
				authorityCalls++;
				throw new Error("clock");
			},
			authorizeUnpriced: () => {
				authorityCalls++;
				throw new Error("policy");
			},
		};
		const cases: unknown[] = [
			null,
			proxy(valid),
			accessor("requestId"),
			accessor("inventory"),
			accessor("pricing"),
			{ ...valid, requestId: proxy({}) },
			{ ...valid, inventory: proxy(inventory) },
			{ ...valid, pricing: proxy(pricing) },
			{
				...valid,
				inventory: {
					...inventory,
					resources: [proxy(inventory.resources[0] ?? {})],
				},
			},
			{ ...valid, ignoredPolicy: "allow" },
			{ ...valid, [Symbol("ignoredPolicy")]: true },
			{ ...valid, requestId: "a".repeat(5000) },
		];
		for (const input of cases) {
			const result = await admitUnpricedIacTarget(
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed inputs intentionally exercise the public runtime boundary.
				input as never,
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed dependencies intentionally exercise the public runtime boundary.
				deps as never,
			);
			expect(result).toMatchObject({
				status: "denied",
				code: "REQUEST_INVALID",
				budget: { reservation: "not-created" },
			});
		}
		expect(traps).toBe(0);
		expect(authorityCalls).toBe(0);
	});

	it("rejects inaccessible revalidation receipts and plans without traps or authority calls", async () => {
		const { plan } = fixture();
		let traps = 0;
		let calls = 0;
		const hostile = (value: object) =>
			new Proxy(value, {
				get() {
					traps++;
					throw new Error("trap");
				},
				getOwnPropertyDescriptor() {
					traps++;
					throw new Error("trap");
				},
				ownKeys() {
					traps++;
					throw new Error("trap");
				},
			});
		const financial = createIacFinancialServices({
			authority: {
				revalidateUnbounded: () => {
					calls++;
					return true;
				},
				revalidatePriced: () => {
					calls++;
					return true;
				},
			} as never,
			now: () => {
				calls++;
				return now;
			},
		});
		const receipt = {
			requestId: "request",
			targetId: "yard",
			status: "admitted",
			requestDigest: `sha256:${"a".repeat(64)}`,
			inventoryHash: `sha256:${"b".repeat(64)}`,
		};
		const accessor = Object.defineProperty({ ...receipt }, "status", {
			enumerable: true,
			get() {
				traps++;
				throw new Error("trap");
			},
		});
		for (const bad of [
			hostile(receipt),
			accessor,
			{ ...receipt, budget: hostile({}) },
			{ ...receipt, reservation: hostile({}) },
		])
			expect(await financial.revalidate(bad as never, plan)).toBe(false);
		expect(await financial.revalidate(receipt, hostile(plan) as never)).toBe(
			false,
		);
		expect(traps).toBe(0);
		expect(calls).toBe(0);
	});

	it.each([
		"top-level",
		"resource",
	])("rejects %s unknown inventory data before cloning or policy", async (location) => {
		const { plan } = fixture();
		const inventory = createTargetPricingInventory({ ...plan, complete: true });
		const target =
			location === "top-level" ? inventory : inventory.resources[0];
		if (target === undefined) throw new Error("missing resource");
		Object.defineProperty(target, "unknownScope", {
			value: "additional account",
			enumerable: true,
		});
		let authorityCalls = 0;
		const deps = {
			get authority() {
				authorityCalls++;
				throw new Error("authority");
			},
			now: () => {
				authorityCalls++;
				throw new Error("clock");
			},
			authorizeUnpriced: () => {
				authorityCalls++;
				throw new Error("policy");
			},
		};
		const result = await admitUnpricedIacTarget(
			{
				requestId: "request",
				inventory,
				pricing: targetPricingUnavailable("no model"),
			},
			deps as never,
		);
		expect(result).toMatchObject({
			status: "denied",
			code: "TARGET_INVENTORY_INCOMPLETE",
			budget: { reservation: "not-created" },
		});
		expect(authorityCalls).toBe(0);
	});

	/* oxlint-enable anti-slop/no-object-parameters, anti-slop/require-safety-comment-for-type-assertion */
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
		const assessment = financial.assess(plan);
		expect(assessment.quote).toMatchObject({
			ok: false,
			code: "PRICING_MODEL_UNAVAILABLE",
		});
		expect(assessment).toMatchObject({
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
			admissionPath: { kind: "unavailable", code: "PRICING_MODEL_UNAVAILABLE" },
			providerCoverage: {
				basis: "declared-inventory",
				providers: [
					{
						providerId: "provider",
						status: "unavailable",
						resources: [{ resourceId: "worker", binding: "unavailable" }],
					},
				],
			},
		});
		expect(await financial.admit("attempt", plan)).toMatchObject({
			status: "denied",
			code: "PRICING_MODEL_UNAVAILABLE",
			budget: { evaluation: "unavailable", reservation: "not-created" },
		});
		expect(authority.read(now).unboundedExposureCount).toBe(0);
		authority.close();
	});

	it("keeps the captured unpriced policy path when the original options change", async () => {
		const { authority, plan, authorize } = fixture();
		try {
			const options = { authority, now: () => now, unpriced: { authorize } };
			const financial = createIacFinancialServices(options);
			Reflect.deleteProperty(options, "unpriced");
			let reads = 0;
			Object.defineProperty(options, "unpriced", {
				get() {
					reads++;
					throw new Error("substituted unpriced policy");
				},
			});
			expect(financial.assess(plan).admissionPath).toEqual({
				kind: "unpriced-policy",
				budget: "bypassed-if-authorized",
			});
			expect(await financial.admit("captured-policy", plan)).toMatchObject({
				status: "admitted",
				budget: { evaluation: "bypassed", reservation: "held" },
			});
			expect(reads).toBe(0);
		} finally {
			authority.close();
		}
	});

	it("does not advertise an unpriced policy added after construction", async () => {
		const { authority, plan, authorize } = fixture();
		try {
			const options = { authority, now: () => now };
			const financial = createIacFinancialServices(options);
			let reads = 0;
			Object.defineProperty(options, "unpriced", {
				get() {
					reads++;
					return { authorize };
				},
			});
			expect(financial.assess(plan).admissionPath).toEqual({
				kind: "unavailable",
				code: "PRICING_MODEL_UNAVAILABLE",
			});
			expect(await financial.admit("added-policy", plan)).toMatchObject({
				status: "denied",
				code: "PRICING_MODEL_UNAVAILABLE",
				budget: { reservation: "not-created" },
			});
			expect(reads).toBe(0);
		} finally {
			authority.close();
		}
	});

	it("requires explicit policy and creates a durable unbounded claim rather than a quote", async () => {
		const { authority, plan, authorize } = fixture();
		const financial = createIacFinancialServices({
			authority,
			now: () => now,
			unpriced: { authorize },
		});
		expect(financial.assess(plan)).toMatchObject({
			budget: { evaluation: "not-evaluated", reservation: "not-created" },
			admissionPath: {
				kind: "unpriced-policy",
				budget: "bypassed-if-authorized",
			},
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
					// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: model a malformed JavaScript authority at the trust boundary.
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
		"missing-reasons",
		"unknown-gate",
		"unknown-decision",
		"non-json-event",
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
						if (kind === "missing-reasons")
							Object.defineProperty(decision.gate, "reasons", {
								value: undefined,
							});
						if (kind === "unknown-gate")
							Object.defineProperty(decision.gate, "condition", {
								value: "unfulfilled",
								enumerable: true,
							});
						if (kind === "unknown-decision")
							Object.defineProperty(decision, "condition", {
								value: undefined,
								enumerable: true,
							});
						if (kind === "non-json-event")
							Object.defineProperty(decision.gate, "events", {
								value: [
									Object.defineProperty({}, "future", {
										value: undefined,
										enumerable: true,
									}),
								],
							});
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

	it("rejects unknown policy and scope proof fields before revalidation", async () => {
		const { authority, plan, authorize } = fixture();
		try {
			const financial = createIacFinancialServices({
				authority,
				now: () => now,
				unpriced: { authorize },
			});
			const admission = await financial.admit("exact-proof", plan);
			if (
				!admission.unpricedPolicyProof?.identity ||
				!admission.reservation?.unpricedScopeProof?.identity
			)
				throw new Error("missing proof");
			expect(await financial.revalidate(admission, plan)).toBe(true);
			const structural = structuredClone(admission);
			const structuralPolicy = structural.unpricedPolicyProof;
			const structuralScope = structural.reservation?.unpricedScopeProof;
			if (!structuralPolicy?.identity || !structuralScope?.identity)
				throw new Error("missing proof");
			for (const value of [
				structuralPolicy,
				structuralPolicy.identity,
				structuralScope,
				structuralScope.identity,
			])
				Reflect.deleteProperty(value, "$typeName");
			expect(await financial.revalidate(structural, plan)).toBe(true);
			const authorityCheck = vi.spyOn(authority, "revalidateUnbounded");
			for (const kind of [
				"policy",
				"policy-identity",
				"scope",
				"scope-identity",
			]) {
				const tampered = structuredClone(admission);
				const policy = tampered.unpricedPolicyProof;
				const scope = tampered.reservation?.unpricedScopeProof;
				if (!policy?.identity || !scope?.identity)
					throw new Error("missing proof");
				const value =
					kind === "policy"
						? policy
						: kind === "policy-identity"
							? policy.identity
							: kind === "scope"
								? scope
								: scope.identity;
				Object.defineProperty(value, "unknownObligation", {
					enumerable: true,
					value: "must not disappear",
				});
				expect(await financial.revalidate(tampered, plan)).toBe(false);
			}
			expect(authorityCheck).not.toHaveBeenCalled();
			authorityCheck.mockRestore();
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
			expect(financial.assess(plan)).toMatchObject({
				admissionPath: {
					kind: "unpriced-policy",
					budget: "bypassed-if-authorized",
				},
				budget: { evaluation: "not-evaluated", reservation: "not-created" },
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
