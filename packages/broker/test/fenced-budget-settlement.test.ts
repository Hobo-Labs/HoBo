import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create, toJsonString } from "@bufbuild/protobuf";
import { canonicalFenceOperationReceipt } from "@hobo/data-core";
import { stableHash } from "@hobo/pricing";
import fc from "fast-check";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
	BudgetFenceSettlementGuardSchema,
	IacPricingPinSchema,
} from "../src/_generated/yard_placement_pb.js";
import {
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
	BudgetEntitlementSchema,
	BudgetLedgerSnapshotSchema,
	BudgetReservationSchema,
	createBudgetAdmissionAuthority,
	EntitlementClaimSchema,
	HostingQuoteSchema,
	ProviderAccountExposureSchema,
} from "../src/budget-authority.js";
import {
	type BudgetFenceGuardRequest,
	type BudgetFenceTrust,
	canonicalBudgetFenceSettlement,
} from "../src/budget-fence-settlement.js";
import { createPostgresBudgetAdmissionAuthority } from "../src/budget-postgres.js";
import { createSqliteBudgetAdmissionAuthority } from "../src/budget-sqlite.js";

const now = "2026-10-29T12:00:00Z";
const REQUEST = `sha256:${"c".repeat(64)}`;
const PLAN = `sha256:${"d".repeat(64)}`;
const EXECUTION = `sha256:${"e".repeat(64)}`;
const initial = () =>
	create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "hosting",
			periodId: "2026-10",
			policyRevision: "r1",
		},
		seq: 0,
		limitMicros: 200,
		spentMicros: 0,
		reservedMicros: 0,
		observedAt: "2026-10-29T00:00:00Z",
		validUntil: "2026-11-01T00:00:00Z",
		providerAccounts: [
			{ providerAccountId: "source-account", limitMicros: 200 },
			{ providerAccountId: "dest-account", limitMicros: 200 },
		],
	});
const source = {
	yardId: "old-yard",
	campId: "old-placement",
	providerId: "supabase",
	providerAccountId: "source-account",
	resourceId: "old-db",
	deploymentId: "old-deployment",
	incarnationId: "old-incarnation",
	manifestHash: `sha256:${"6".repeat(64)}`,
	planHash: `sha256:${"7".repeat(64)}`,
};
const destination = {
	yardId: "new-yard",
	campId: "new-placement",
	providerId: "postgres",
	providerAccountId: "dest-account",
	resourceId: "new-db",
	deploymentId: "new-deployment",
	incarnationId: "new-incarnation",
	manifestHash: `sha256:${"8".repeat(64)}`,
	planHash: PLAN,
};
const fenceRequest: BudgetFenceGuardRequest = {
	dataset: "orders",
	operationId: "move-1",
	fenceTokenDigest: `sha256:${"a".repeat(64)}`,
	receiverKeyId: "receiver-key",
	financeKeyId: "finance-key",
	logicalCampId: "orders-camp",
	source,
	destination,
	decision: "to-target",
	executionDigest: EXECUTION,
	expectedRouteGeneration: "42",
	currentSetId: "set:old",
	desiredSetId: "set:new",
	migrationId: "migration-1",
	decisionHead: "5",
};
function fixture() {
	const receiver = generateKeyPairSync("ed25519");
	const finance = generateKeyPairSync("ed25519");
	const trust: BudgetFenceTrust = {
		receivers: [
			{
				keyId: "receiver-key",
				publicKey: receiver.publicKey,
				tenantId: "tenant",
				sourceScopeTenant: "",
				dataset: "orders",
				source,
				destination,
			},
		],
		finance: [
			{
				keyId: "finance-key",
				publicKey: finance.publicKey,
				tenantId: "tenant",
				budgetId: "hosting",
				providerAccounts: [
					{ providerId: "supabase", providerAccountId: "source-account" },
					{ providerId: "postgres", providerAccountId: "dest-account" },
				],
			},
		],
	};
	const quote = create(HostingQuoteSchema, {
		quoteId: "q1",
		yardId: "new-yard",
		providerId: "postgres",
		ownerTenantId: "tenant",
		currency: "USD",
		totalMicros: 40,
		liabilityBoundMicros: 60,
		components: [{ name: "move", costMicros: 40 }],
		requestDigest: REQUEST,
		financialPlanHash: PLAN,
		observedAt: "2026-10-29T00:00:00Z",
		validUntil: "2026-11-01T00:00:00Z",
		providerAccounts: [
			{ providerAccountId: "source-account", liabilityMicros: 20 },
			{ providerAccountId: "dest-account", liabilityMicros: 40 },
		],
	});
	const base = initial();
	if (!base.identity) throw new Error("test identity missing");
	const input = {
		reservationId: "reservation-1",
		requestDigest: REQUEST,
		identity: base.identity,
		quote,
		expectedSeq: 0,
		now,
		fenceSettlementGuard: fenceRequest,
	};
	function evidence(
		reservation: ReturnType<
			ReturnType<typeof createBudgetAdmissionAuthority>["lookup"]
		>,
		actualMicros = 30,
		payloadVersion: "v1" | "v2" = "v2",
	) {
		const guard = reservation?.fenceSettlementGuard;
		if (!guard || !reservation) throw new Error("guard missing");
		const body = {
			contract: "hobo.fence-operation-receipt/v1" as const,
			scope: { dataset: guard.dataset, tenant: guard.scopeTenant },
			operationId: guard.operationId,
			routeDigest: guard.routeDigest,
			receiverKeyId: guard.receiverKeyId,
			fenceTokenDigest: guard.fenceTokenDigest,
			outcome: "committed" as const,
		};
		const receipt = {
			...body,
			signature: sign(
				null,
				Buffer.from(canonicalFenceOperationReceipt(body)),
				receiver.privateKey,
			).toString("base64url"),
		};
		const result = {
			usageEvidenceRef: "provider-usage:final",
			sourceStoppedEvidenceRef: "source:retired",
			fenceOperationReceiptJson: JSON.stringify(receipt),
			providerAccounts: [
				create(ProviderAccountExposureSchema, {
					providerAccountId: "source-account",
					liabilityMicros: Math.floor(actualMicros / 3),
				}),
				create(ProviderAccountExposureSchema, {
					providerAccountId: "dest-account",
					liabilityMicros: actualMicros - Math.floor(actualMicros / 3),
				}),
			],
			entitlementClaims: reservation.entitlementClaims.map((claim) => ({
				...claim,
			})),
		};
		return {
			...result,
			financeSignature: sign(
				null,
				Buffer.from(
					canonicalBudgetFenceSettlement(
						reservation,
						actualMicros,
						result,
						payloadVersion,
					),
				),
				finance.privateKey,
			).toString("base64url"),
		};
	}
	return { receiver, finance, trust, quote, base, input, evidence };
}

describe("receiver-bound budget settlement", () => {
	it("accepts an authenticated fence guard as the priced IaC settlement authority", () => {
		const f = fixture();
		const fields = {
			planDigest: `sha256:${"1".repeat(64)}`,
			inventoryHash: `sha256:${"2".repeat(64)}`,
			modelHash: `sha256:${"3".repeat(64)}`,
			quoteHash: `sha256:${"4".repeat(64)}`,
			evidenceHash: `sha256:${"5".repeat(64)}`,
		};
		const financialPlanHash = stableHash(fields);
		const destinationWithPlan = { ...destination, planHash: financialPlanHash };
		f.quote.financialPlanHash = financialPlanHash;
		const trust = {
			...f.trust,
			receivers: f.trust.receivers.map((receiver) => ({
				...receiver,
				destination: destinationWithPlan,
			})),
		};
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: trust,
		});
		expect(() =>
			authority.reserve({
				...f.input,
				fenceSettlementGuard: {
					...fenceRequest,
					destination: destinationWithPlan,
					financeKeyId: "unknown",
				},
				iacPricingPin: create(IacPricingPinSchema, {
					...fields,
					validUntil: f.quote.validUntil,
				}),
			}),
		).toThrow("independently enrolled");
		expect(authority.read(now).reservedMicros).toBe(0);
		const held = authority.reserve({
			...f.input,
			fenceSettlementGuard: {
				...fenceRequest,
				destination: destinationWithPlan,
			},
			iacPricingPin: create(IacPricingPinSchema, {
				...fields,
				validUntil: f.quote.validUntil,
			}),
		});
		expect(held.fenceSettlementGuard).toBeDefined();
		expect(
			authority.claimExecution({
				reservationId: held.reservationId,
				requestDigest: REQUEST,
				executionDigest: EXECUTION,
			}),
		).toMatchObject({ status: "held", executionDigest: EXECUTION });
	});
	it("retains claimed funds until both the exact receiver and finance authorities sign", () => {
		const f = fixture();
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: f.trust,
		});
		const held = authority.reserve(f.input);
		expect(held.fenceSettlementGuard?.routeDigest).toMatch(
			/^sha256:[a-f0-9]{64}$/u,
		);
		if (!held.fenceSettlementGuard) throw new Error("guard missing");
		const wireGuard = JSON.parse(
			toJsonString(BudgetFenceSettlementGuardSchema, held.fenceSettlementGuard),
		);
		expect(Object.hasOwn(wireGuard, "scopeTenant")).toBe(false);
		expect(() =>
			authority.claimExecution({
				reservationId: "reservation-1",
				requestDigest: REQUEST,
				executionDigest: "stale",
			}),
		).toThrow("admitted execution");
		authority.claimExecution({
			reservationId: "reservation-1",
			requestDigest: REQUEST,
			executionDigest: EXECUTION,
		});
		expect(() => authority.release("reservation-1", true, "forged")).toThrow(
			"execution-claimed",
		);
		expect(() =>
			authority.settle("reservation-1", 30, {
				usageEvidenceRef: "forged",
				sourceStoppedEvidenceRef: "forged",
			}),
		).toThrow("terminal receipt");
		expect(authority.read(now).reservedMicros).toBe(60);
		const proof = f.evidence(authority.lookup("reservation-1"));
		expect(() =>
			authority.settle("reservation-1", 30, {
				...proof,
				financeSignature: "A".repeat(86),
			}),
		).toThrow();
		expect(() => authority.settle("reservation-1", 31, proof)).toThrow(
			"financial settlement signature invalid",
		);
		expect(() =>
			authority.settle("reservation-1", 30, {
				...proof,
				usageEvidenceRef: "substituted",
			}),
		).toThrow("financial settlement signature invalid");
		expect(authority.read(now).reservedMicros).toBe(60);
		expect(authority.settle("reservation-1", 30, proof).status).toBe("settled");
		expect(authority.read(now)).toMatchObject({
			reservedMicros: 0,
			spentMicros: 30,
		});
		expect(authority.settle("reservation-1", 30, proof).status).toBe("settled");
		expect(() => authority.settle("reservation-1", 31, proof)).toThrow();
	});

	it("verifies legacy v1 finance signatures only for pre-kind reservations", () => {
		const f = fixture();
		f.base.entitlements = [
			create(BudgetEntitlementSchema, {
				bucketId: "free-requests",
				kind: "allowance",
				unit: "request",
				periodId: "2026-10",
				remainingUnits: 5,
				reservedUnits: 0,
				observedAt: "2026-10-29T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
			}),
		];
		f.quote.entitlementClaims = [
			create(EntitlementClaimSchema, {
				bucketId: "free-requests",
				kind: "allowance",
				unit: "request",
				units: 2,
			}),
		];
		const events: BudgetAuthorityEvent[] = [];
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: f.trust,
			commit: (event) => events.push(event),
		});
		authority.reserve(f.input);
		authority.claimExecution({
			reservationId: "reservation-1",
			requestDigest: REQUEST,
			executionDigest: EXECUTION,
		});
		const held = authority.lookup("reservation-1");
		if (!held) throw new Error("held reservation missing");
		const currentProof = f.evidence(held);
		expect(
			canonicalBudgetFenceSettlement(held, 30, currentProof).startsWith(
				'["hobo.budget-fence-settlement/v2"',
			),
		).toBe(true);
		const legacyHeld = clone(BudgetReservationSchema, held);
		legacyHeld.fenceSettlementPayloadVersion = "";
		for (const claim of legacyHeld.entitlementClaims) claim.kind = "";
		const legacyProof = f.evidence(legacyHeld, 30, "v1");
		expect(canonicalBudgetFenceSettlement(legacyHeld, 30, legacyProof)).toBe(
			canonicalBudgetFenceSettlement(legacyHeld, 30, legacyProof, "v1"),
		);
		expect(() => authority.settle("reservation-1", 30, legacyProof)).toThrow();
		authority.settle("reservation-1", 30, currentProof);
		const legacyBase = clone(BudgetLedgerSnapshotSchema, f.base);
		for (const entitlement of legacyBase.entitlements) entitlement.kind = "";
		const legacyEvents = events.map((event) => {
			const legacy = clone(BudgetAuthorityEventSchema, event);
			for (const entitlement of legacy.snapshot?.entitlements ?? [])
				entitlement.kind = "";
			for (const reservation of legacy.reservations) {
				reservation.fenceSettlementPayloadVersion = "";
				for (const claim of reservation.entitlementClaims) claim.kind = "";
				for (const claim of reservation.settlementEvidence?.entitlementClaims ??
					[])
					claim.kind = "";
				if (reservation.settlementEvidence)
					reservation.settlementEvidence.financeSignature =
						legacyProof.financeSignature;
			}
			return legacy;
		});
		const reopened = createBudgetAdmissionAuthority({
			snapshot: legacyBase,
			priorEvents: legacyEvents,
			fenceTrust: f.trust,
		});
		expect(reopened.lookup("reservation-1")?.status).toBe("settled");
		expect(reopened.read(now).entitlements[0]).toMatchObject({
			kind: "allowance",
			remainingUnits: 3,
		});
	});

	it("backfills v2 for kind-bearing fenced reservation replay", () => {
		const f = fixture();
		f.base.entitlements = [
			create(BudgetEntitlementSchema, {
				bucketId: "free-requests",
				kind: "allowance",
				unit: "request",
				periodId: "2026-10",
				remainingUnits: 5,
				reservedUnits: 0,
				observedAt: "2026-10-29T00:00:00Z",
				validUntil: "2026-11-01T00:00:00Z",
			}),
		];
		f.quote.entitlementClaims = [
			create(EntitlementClaimSchema, {
				bucketId: "free-requests",
				kind: "allowance",
				unit: "request",
				units: 2,
			}),
		];
		const events: BudgetAuthorityEvent[] = [];
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: f.trust,
			commit: (event) => events.push(event),
		});
		authority.reserve(f.input);
		authority.claimExecution({
			reservationId: "reservation-1",
			requestDigest: REQUEST,
			executionDigest: EXECUTION,
		});
		const held = authority.lookup("reservation-1");
		if (!held) throw new Error("held reservation missing");
		const proof = f.evidence(held);
		const unversioned = events.map((event) => {
			const legacy = clone(BudgetAuthorityEventSchema, event);
			for (const reservation of legacy.reservations)
				reservation.fenceSettlementPayloadVersion = "";
			return legacy;
		});
		const reopened = createBudgetAdmissionAuthority({
			snapshot: f.base,
			priorEvents: unversioned,
			fenceTrust: f.trust,
		});
		expect(
			reopened.lookup("reservation-1")?.fenceSettlementPayloadVersion,
		).toBe("v2");
		expect(reopened.settle("reservation-1", 30, proof).status).toBe("settled");
	});

	it("replays a legacy v1 reservation without entitlement claims", () => {
		const f = fixture();
		const events: BudgetAuthorityEvent[] = [];
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: f.trust,
			commit: (event) => events.push(event),
		});
		authority.reserve(f.input);
		authority.claimExecution({
			reservationId: "reservation-1",
			requestDigest: REQUEST,
			executionDigest: EXECUTION,
		});
		const held = authority.lookup("reservation-1");
		if (!held) throw new Error("held reservation missing");
		const legacyHeld = clone(BudgetReservationSchema, held);
		legacyHeld.fenceSettlementPayloadVersion = "";
		const legacyProof = f.evidence(legacyHeld, 30, "v1");
		expect(() => authority.settle("reservation-1", 30, legacyProof)).toThrow();
		authority.settle("reservation-1", 30, f.evidence(held));
		const legacyEvents = events.map((event) => {
			const legacy = clone(BudgetAuthorityEventSchema, event);
			for (const reservation of legacy.reservations) {
				reservation.fenceSettlementPayloadVersion = "";
				if (reservation.settlementEvidence)
					reservation.settlementEvidence.financeSignature =
						legacyProof.financeSignature;
			}
			return legacy;
		});
		const reopened = createBudgetAdmissionAuthority({
			snapshot: f.base,
			priorEvents: legacyEvents,
			fenceTrust: f.trust,
		});
		expect(reopened.lookup("reservation-1")?.status).toBe("settled");
	});

	it("requires matching independently enrolled destination and both funded accounts before reservation", () => {
		const f = fixture();
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: f.trust,
		});
		expect(() =>
			authority.reserve({
				...f.input,
				fenceSettlementGuard: {
					...fenceRequest,
					destination: { ...destination, providerAccountId: "foreign" },
				},
			}),
		).toThrow("enrolled receiver");
		expect(() =>
			authority.reserve({
				...f.input,
				fenceSettlementGuard: {
					...fenceRequest,
					source: { ...source, incarnationId: "replacement-incarnation" },
				},
			}),
		).toThrow("enrolled receiver");
		const receiverEnrollment = f.trust.receivers[0];
		const financeEnrollment = f.trust.finance[0];
		if (!receiverEnrollment || !financeEnrollment)
			throw new Error("enrollment missing");
		const sameSigner = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: {
				...f.trust,
				finance: [
					{ ...financeEnrollment, publicKey: receiverEnrollment.publicKey },
				],
			},
		});
		expect(() => sameSigner.reserve(f.input)).toThrow("enrolled receiver");
		const foreignPlanDestination = {
			...destination,
			planHash: `sha256:${"9".repeat(64)}`,
		};
		const wrongPlan = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: {
				...f.trust,
				receivers: [
					{ ...receiverEnrollment, destination: foreignPlanDestination },
				],
			},
		});
		expect(() =>
			wrongPlan.reserve({
				...f.input,
				fenceSettlementGuard: {
					...fenceRequest,
					destination: foreignPlanDestination,
				},
			}),
		).toThrow("financial plan");
		expect(() =>
			authority.reserve({
				...f.input,
				fenceSettlementGuard: { ...fenceRequest, financeKeyId: "unknown" },
			}),
		).toThrow("enrolled fence authorities");
		expect(() =>
			authority.reserve({
				...f.input,
				fenceSettlementGuard: {
					...fenceRequest,
					source: { ...source, resourceId: "foreign-db" },
				},
			}),
		).toThrow("enrolled receiver");
		expect(() =>
			authority.reserve({
				...f.input,
				fenceSettlementGuard: {
					...fenceRequest,
					expectedRouteGeneration: "18446744073709551616",
				},
			}),
		).toThrow("invalid fenced route guard");
		expect(authority.read(now).reservedMicros).toBe(0);
		authority.reserve(f.input);
		const { fenceSettlementGuard, ...withoutGuard } = f.input;
		expect(fenceSettlementGuard).toBe(fenceRequest);
		expect(() => authority.reserve(withoutGuard)).toThrow("replay differs");
		for (const changed of [
			{ expectedRouteGeneration: "43" },
			{ currentSetId: "newer-current" },
			{ desiredSetId: "newer-desired" },
			{ migrationId: "other-migration" },
			{ decisionHead: "6" },
		])
			expect(() =>
				authority.reserve({
					...f.input,
					fenceSettlementGuard: { ...fenceRequest, ...changed },
				}),
			).toThrow("replay differs");
		expect(() =>
			authority.reserve({
				...f.input,
				fenceSettlementGuard: { ...fenceRequest, logicalCampId: "other-camp" },
			}),
		).toThrow("replay differs");
	});

	it("rejects a foreign receiver receipt even when finance signs it", () => {
		const f = fixture();
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: f.trust,
		});
		authority.reserve(f.input);
		authority.claimExecution({
			reservationId: "reservation-1",
			requestDigest: REQUEST,
			executionDigest: EXECUTION,
		});
		const reservation = authority.lookup("reservation-1");
		if (!reservation) throw new Error("reservation missing");
		const valid = f.evidence(reservation);
		const receipt = JSON.parse(valid.fenceOperationReceiptJson);
		const attacker = generateKeyPairSync("ed25519");
		const { signature: _ignored, ...body } = receipt;
		const forged = {
			...body,
			signature: sign(
				null,
				Buffer.from(canonicalFenceOperationReceipt(body)),
				attacker.privateKey,
			).toString("base64url"),
		};
		const unsigned = {
			...valid,
			fenceOperationReceiptJson: JSON.stringify(forged),
		};
		const proof = {
			...unsigned,
			financeSignature: sign(
				null,
				Buffer.from(canonicalBudgetFenceSettlement(reservation, 30, unsigned)),
				f.finance.privateKey,
			).toString("base64url"),
		};
		expect(() => authority.settle("reservation-1", 30, proof)).toThrow(
			"receiver signature invalid",
		);
		expect(authority.read(now).reservedMicros).toBe(60);
	});

	it("cannot reuse a committed receipt for another budget reservation", () => {
		const f = fixture();
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: f.trust,
		});
		authority.reserve(f.input);
		authority.claimExecution({
			reservationId: "reservation-1",
			requestDigest: REQUEST,
			executionDigest: EXECUTION,
		});
		const first = f.evidence(authority.lookup("reservation-1"));
		const secondInput = {
			...f.input,
			reservationId: "reservation-2",
			expectedSeq: authority.read(now).seq,
		};
		authority.reserve(secondInput);
		authority.claimExecution({
			reservationId: "reservation-2",
			requestDigest: REQUEST,
			executionDigest: EXECUTION,
		});
		expect(() => authority.settle("reservation-2", 30, first)).toThrow(
			"receipt scope mismatch",
		);
		expect(authority.read(now).reservedMicros).toBe(120);
	});

	it("replays signed history and rejects a stripped guard, modified receipt or missing enrollment", () => {
		const f = fixture();
		const events: Parameters<
			typeof createBudgetAdmissionAuthority
		>[0]["priorEvents"] extends readonly (infer E)[] | undefined
			? E[]
			: never = [];
		const authority = createBudgetAdmissionAuthority({
			snapshot: f.base,
			fenceTrust: f.trust,
			commit: (event) => {
				events.push(event);
			},
		});
		authority.reserve(f.input);
		authority.claimExecution({
			reservationId: "reservation-1",
			requestDigest: REQUEST,
			executionDigest: EXECUTION,
		});
		const proof = f.evidence(authority.lookup("reservation-1"));
		authority.settle("reservation-1", 30, proof);
		const reopen = (
			priorEvents = events,
			fenceTrust: BudgetFenceTrust | null = f.trust,
		) =>
			createBudgetAdmissionAuthority({
				snapshot: f.base,
				priorEvents,
				...(fenceTrust ? { fenceTrust } : undefined),
			});
		expect(reopen().lookup("reservation-1")?.status).toBe("settled");
		expect(() => reopen(events, null)).toThrow("independently enrolled");
		const enrolledReceiver = f.trust.receivers[0];
		if (!enrolledReceiver) throw new Error("receiver enrollment missing");
		expect(() =>
			reopen(events, {
				...f.trust,
				receivers: [{ ...enrolledReceiver, sourceScopeTenant: "other-scope" }],
			}),
		).toThrow("independently enrolled");
		const removed = events.map((event) =>
			clone(BudgetAuthorityEventSchema, event),
		);
		const row = removed[1]?.reservations[0];
		if (!row) throw new Error("fixture missing");
		row.fenceSettlementGuard = undefined;
		expect(() => reopen(removed)).toThrow("immutable fenced reservation");
		const reversioned = events.map((event) =>
			clone(BudgetAuthorityEventSchema, event),
		);
		const versioned = reversioned[1]?.reservations[0];
		if (!versioned) throw new Error("fixture missing");
		versioned.fenceSettlementPayloadVersion = "";
		expect(() => reopen(reversioned)).toThrow("immutable fenced reservation");
		const reallocated = events.map((event) =>
			clone(BudgetAuthorityEventSchema, event),
		);
		const exposure = reallocated[1]?.reservations[0]?.providerAccounts[0];
		if (!exposure) throw new Error("fixture exposure missing");
		exposure.liabilityMicros = 0;
		expect(() => reopen(reallocated)).toThrow("immutable fenced reservation");
		const forged = events.map((event) =>
			clone(BudgetAuthorityEventSchema, event),
		);
		const settled = forged[2]?.reservations[0];
		if (!settled?.settlementEvidence) throw new Error("fixture missing");
		settled.settlementEvidence.financeSignature = "A".repeat(86);
		expect(() => reopen(forged)).toThrow();
	});

	it("persists the guard across independent SQLite connections and restart", () => {
		const f = fixture();
		const dir = mkdtempSync(join(tmpdir(), "hobo-budget-fence-"));
		const path = join(dir, "authority.sqlite");
		let first:
			| ReturnType<typeof createSqliteBudgetAdmissionAuthority>
			| undefined;
		let second:
			| ReturnType<typeof createSqliteBudgetAdmissionAuthority>
			| undefined;
		try {
			first = createSqliteBudgetAdmissionAuthority({
				path,
				snapshot: f.base,
				fenceTrust: f.trust,
				now: () => now,
			});
			second = createSqliteBudgetAdmissionAuthority({
				path,
				snapshot: f.base,
				fenceTrust: f.trust,
				now: () => now,
			});
			first.reserve(f.input);
			second.claimExecution({
				reservationId: "reservation-1",
				requestDigest: REQUEST,
				executionDigest: EXECUTION,
			});
			const proof = f.evidence(first.lookup("reservation-1"));
			expect(() =>
				first?.settle("reservation-1", 30, {
					...proof,
					financeSignature: "bad",
				}),
			).toThrow();
			first.close();
			first = undefined;
			second.close();
			second = undefined;
			first = createSqliteBudgetAdmissionAuthority({
				path,
				snapshot: f.base,
				fenceTrust: f.trust,
				now: () => now,
			});
			expect(first.read(now).reservedMicros).toBe(60);
			expect(first.settle("reservation-1", 30, proof).status).toBe("settled");
			first.close();
			first = undefined;
			second = createSqliteBudgetAdmissionAuthority({
				path,
				snapshot: f.base,
				fenceTrust: f.trust,
				now: () => now,
			});
			expect(second.settle("reservation-1", 30, proof).status).toBe("settled");
			expect(second.read(now).spentMicros).toBe(30);
		} finally {
			first?.close();
			second?.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

it.runIf(!!process.env.HOBO_TEST_POSTGRES_URL)(
	"serializes simultaneous receipt settlement and preserves it across PostgreSQL connections",
	async () => {
		const connectionString = process.env.HOBO_TEST_POSTGRES_URL;
		if (!connectionString) throw new Error("test PostgreSQL URL missing");
		const schema = `hobo_fenced_budget_${randomBytes(8).toString("hex")}`;
		const admin = new Pool({ connectionString });
		let pool: Pool | undefined;
		try {
			await admin.query(`CREATE SCHEMA "${schema}"`);
			pool = new Pool({
				connectionString,
				options: `-c search_path=${schema}`,
				max: 4,
			});
			const f = fixture();
			const first = createPostgresBudgetAdmissionAuthority({
				pool,
				snapshot: f.base,
				fenceTrust: f.trust,
				now: () => now,
			});
			const second = createPostgresBudgetAdmissionAuthority({
				pool,
				snapshot: f.base,
				fenceTrust: f.trust,
				now: () => now,
			});
			await first.initialize();
			await first.reserve(f.input);
			await second.claimExecution({
				reservationId: "reservation-1",
				requestDigest: REQUEST,
				executionDigest: EXECUTION,
			});
			const proof = f.evidence(await first.lookup("reservation-1"));
			const results = await Promise.allSettled([
				first.settle("reservation-1", 30, proof),
				second.settle("reservation-1", 30, proof),
				second.release("reservation-1", true, "stale-unused"),
			]);
			expect(results[0]?.status).toBe("fulfilled");
			expect(results[1]?.status).toBe("fulfilled");
			expect(results[2]?.status).toBe("rejected");
			expect(await second.read(now)).toMatchObject({
				spentMicros: 30,
				reservedMicros: 0,
			});
			const reopened = createPostgresBudgetAdmissionAuthority({
				pool,
				snapshot: f.base,
				fenceTrust: f.trust,
				now: () => now,
			});
			expect((await reopened.lookup("reservation-1"))?.status).toBe("settled");
			expect((await reopened.settle("reservation-1", 30, proof)).status).toBe(
				"settled",
			);
		} finally {
			if (pool) await pool.end();
			await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
			await admin.end();
		}
	},
);

describe("receiver-bound budget settlement generated histories", () => {
	it("retains the hold across forged or mismatched proofs and replay", () => {
		const attacks = fc.constantFrom(
			"receiver",
			"finance",
			"amount",
			"usage-reference",
			"account-usage",
			"receipt-scope",
		);
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 60 }),
				fc.boolean(),
				fc.array(attacks, { minLength: 1, maxLength: 8 }),
				(actual, markUncertain, attempts) => {
					const f = fixture();
					const attacker = generateKeyPairSync("ed25519");
					const events: Parameters<
						typeof createBudgetAdmissionAuthority
					>[0]["priorEvents"] extends readonly (infer E)[] | undefined
						? E[]
						: never = [];
					const authority = createBudgetAdmissionAuthority({
						snapshot: f.base,
						fenceTrust: f.trust,
						commit(event) {
							events.push(event);
						},
					});
					authority.reserve(f.input);
					if (markUncertain) authority.uncertain("reservation-1");
					const claim = {
						reservationId: "reservation-1",
						requestDigest: REQUEST,
						executionDigest: EXECUTION,
					};
					const held = authority.lookup("reservation-1");
					const proof = f.evidence(held, actual);
					expect(() =>
						authority.settle("reservation-1", actual, proof),
					).toThrow();
					expect(() =>
						authority.claimExecution({ ...claim, executionDigest: PLAN }),
					).toThrow("admitted execution");
					authority.claimExecution(claim);
					const reservation = authority.lookup("reservation-1");
					if (!reservation) throw new Error("reservation missing");
					for (const attack of attempts) {
						const before = authority.read(now);
						const eventCount = events.length;
						let altered = proof;
						let charged = actual;
						switch (attack) {
							case "receiver": {
								const receipt = JSON.parse(proof.fenceOperationReceiptJson);
								const { signature: _signature, ...body } = receipt;
								const forged = {
									...body,
									signature: sign(
										null,
										Buffer.from(canonicalFenceOperationReceipt(body)),
										attacker.privateKey,
									).toString("base64url"),
								};
								const unsigned = {
									...proof,
									fenceOperationReceiptJson: JSON.stringify(forged),
								};
								altered = {
									...unsigned,
									financeSignature: sign(
										null,
										Buffer.from(
											canonicalBudgetFenceSettlement(
												reservation,
												actual,
												unsigned,
											),
										),
										f.finance.privateKey,
									).toString("base64url"),
								};
								break;
							}
							case "finance":
								altered = {
									...proof,
									financeSignature: sign(
										null,
										Buffer.from(
											canonicalBudgetFenceSettlement(
												reservation,
												actual,
												proof,
											),
										),
										attacker.privateKey,
									).toString("base64url"),
								};
								break;
							case "amount":
								charged++;
								break;
							case "usage-reference":
								altered = { ...proof, usageEvidenceRef: "substituted" };
								break;
							case "account-usage":
								altered = {
									...proof,
									providerAccounts: proof.providerAccounts.map((row, index) =>
										index === 0
											? { ...row, liabilityMicros: row.liabilityMicros + 1 }
											: row,
									),
								};
								break;
							case "receipt-scope": {
								const receipt = JSON.parse(proof.fenceOperationReceiptJson);
								altered = {
									...proof,
									fenceOperationReceiptJson: JSON.stringify({
										...receipt,
										operationId: "other-operation",
									}),
								};
								break;
							}
						}
						expect(() =>
							authority.settle("reservation-1", charged, altered),
						).toThrow();
						expect(authority.read(now)).toEqual(before);
						expect(events).toHaveLength(eventCount);
						expect(before.reservedMicros).toBe(60);
						expect(() =>
							authority.release("reservation-1", true, "unused"),
						).toThrow();
						expect(
							createBudgetAdmissionAuthority({
								snapshot: f.base,
								fenceTrust: f.trust,
								priorEvents: events,
							}).read(now),
						).toEqual(before);
					}
					authority.settle("reservation-1", actual, proof);
					const after = authority.read(now);
					expect(after).toMatchObject({
						reservedMicros: 0,
						spentMicros: actual,
					});
					const eventCount = events.length;
					authority.settle("reservation-1", actual, proof);
					expect(events).toHaveLength(eventCount);
					expect(
						createBudgetAdmissionAuthority({
							snapshot: f.base,
							fenceTrust: f.trust,
							priorEvents: events,
						}).read(now),
					).toEqual(after);
				},
			),
			{ seed: 614450, numRuns: 120 },
		);
	});
});
