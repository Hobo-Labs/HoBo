import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create, toJsonString } from "@bufbuild/protobuf";
import { canonicalFenceOperationReceipt } from "@hobo/data-core";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { BudgetFenceSettlementGuardSchema } from "../src/_generated/yard_placement_pb.js";
import {
	BudgetAuthorityEventSchema,
	BudgetLedgerSnapshotSchema,
	createBudgetAdmissionAuthority,
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
					liabilityMicros: 10,
				}),
				create(ProviderAccountExposureSchema, {
					providerAccountId: "dest-account",
					liabilityMicros: 20,
				}),
			],
		};
		return {
			...result,
			financeSignature: sign(
				null,
				Buffer.from(
					canonicalBudgetFenceSettlement(reservation, actualMicros, result),
				),
				finance.privateKey,
			).toString("base64url"),
		};
	}
	return { receiver, finance, trust, quote, base, input, evidence };
}

describe("receiver-bound budget settlement", () => {
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
