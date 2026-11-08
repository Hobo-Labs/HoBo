import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clone, create } from "@bufbuild/protobuf";
import {
	BudgetAdmissionDeniedError,
	type BudgetLedgerSnapshot,
	BudgetLedgerSnapshotSchema,
	createBudgetAdmissionAuthority,
	createPostgresBudgetAdmissionAuthority,
	createSqliteBudgetAdmissionAuthority,
	type HostingQuote,
	HostingQuoteSchema,
} from "@hobo/broker";
import {
	canonicalBudgetPolicyJson,
	parseBudgetPolicy,
	parseBudgetPolicyJson,
} from "@hobo/core";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
	type Lease,
	LeaseSchema,
	SandboxAllowanceSchema,
} from "../src/_generated/ci_pb.js";
import {
	ciExecutionDigest,
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiAsyncSharedBudgetHooks,
	createCiSharedBudgetHooks as createHooks,
} from "../src/shared-budget.js";

const NOW = "2026-10-30T12:00:00Z";
const UNTIL = "2026-10-31T00:00:00Z";
const cleanup: (() => void)[] = [];
const livePools: Pool[] = [];
function createCiSharedBudgetHooks(options: Parameters<typeof createHooks>[0]) {
	return createHooks({ now: () => NOW, ...options });
}
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) close();
	await Promise.all(livePools.splice(0).map((pool) => pool.end()));
});
function policy(enforcement = "conservative", limitMicros = 100) {
	return canonicalBudgetPolicyJson(
		parseBudgetPolicy({
			schemaVersion: "hobo.budget-policy/v1",
			tenantId: "tenant",
			budgetId: "shared",
			periodId: "p1",
			revision: "v1",
			workloads: ["hosting", "ci"],
			currency: "USD",
			limitMicros,
			objective: "min-cost",
			enforcement,
			periodKind: "manual",
			constraints: [],
		}),
	);
}
function snapshot() {
	return create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "shared",
			periodId: "p1",
			policyRevision: "v1",
		},
		limitMicros: 100,
		observedAt: NOW,
		validUntil: UNTIL,
		providerAccounts: [
			{ providerAccountId: "native:account", limitMicros: 100 },
		],
		entitlements: [
			{
				bucketId: "shared-credit",
				unit: "micro-minutes",
				periodId: "p1",
				remainingUnits: 1000000,
				observedAt: NOW,
				validUntil: UNTIL,
			},
		],
	});
}
function lease() {
	return create(LeaseSchema, {
		id: "lease-a",
		accountId: "ci-account",
		offerId: "offer",
		provider: "github",
		providerAccountId: "native:account",
		jobId: 1,
		originalRunId: 10,
		runAttempt: 1,
		repositoryId: 2,
		installationId: 3,
		repository: "org/repo",
		state: "reserved",
		reservedMinutes: 1,
		reservedPaidMicros: 60,
		priceMicrosPerMinute: 60,
		budgetTenantId: "tenant",
		budgetId: "shared",
		budgetPeriodId: "p1",
		budgetPolicyRevision: "v1",
		budgetPolicyDigest: policy(),
		budgetAdmissionAttempt: 1,
		createdAt: NOW,
	});
}
function quoteLease(row: Lease) {
	return create(HostingQuoteSchema, {
		quoteId: `quote:${ciReservationId(row)}`,
		yardId: `ci:${row.accountId}`,
		providerId: row.provider,
		ownerTenantId: row.budgetTenantId,
		currency: "USD",
		totalMicros: row.reservedPaidMicros,
		liabilityBoundMicros: row.reservedPaidMicros,
		observedAt: NOW,
		validUntil: UNTIL,
		components: [
			{ name: "complete-ci-liability", costMicros: row.reservedPaidMicros },
		],
		requestDigest: ciRequestDigest(row),
		financialPlanHash: ciFinancialPlanHash(row),
		providerAccounts: [
			{
				providerAccountId: row.providerAccountId,
				liabilityMicros: row.reservedPaidMicros,
			},
		],
		entitlementClaims: row.reservedFreeMinutes
			? [
					{
						bucketId: "shared-credit",
						unit: "micro-minutes",
						units: row.reservedFreeMinutes * 1000000,
					},
				]
			: [],
	});
}
function runnerCoverage(
	row: Lease,
	quote: HostingQuote,
	ledger: BudgetLedgerSnapshot,
): boolean {
	const claim = quote.entitlementClaims[0];
	return (
		quote.entitlementClaims.length === 1 &&
		claim?.bucketId === "shared-credit" &&
		claim.unit === "micro-minutes" &&
		claim.units >= Math.ceil(row.reservedFreeMinutes * 1000000) &&
		ledger.entitlements.some(
			(bucket) =>
				bucket.bucketId === claim.bucketId &&
				bucket.unit === claim.unit &&
				bucket.periodId === row.budgetPeriodId,
		)
	);
}
function durable() {
	const directory = mkdtempSync(join(tmpdir(), "hobo-ci-shared-"));
	cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, "parent.sqlite");
	const first = createSqliteBudgetAdmissionAuthority({
		path,
		snapshot: snapshot(),
		now: () => NOW,
	});
	const second = createSqliteBudgetAdmissionAuthority({
		path,
		snapshot: snapshot(),
		now: () => NOW,
	});
	cleanup.push(
		() => first.close(),
		() => second.close(),
	);
	return { first, second, path };
}
function hosting(
	authority: ReturnType<typeof createSqliteBudgetAdmissionAuthority>,
	cost: number,
) {
	const current = authority.read(NOW);
	if (!current.identity) throw new Error("fixture identity missing");
	const quote = create(HostingQuoteSchema, {
		quoteId: "hosting-quote",
		yardId: "yard",
		providerId: "github",
		ownerTenantId: "tenant",
		currency: "USD",
		totalMicros: cost,
		liabilityBoundMicros: cost,
		requestDigest: "hosting-request",
		observedAt: NOW,
		validUntil: UNTIL,
		components: [{ name: "hosting", costMicros: cost }],
		providerAccounts: [
			{ providerAccountId: "native:account", liabilityMicros: cost },
		],
	});
	return authority.reserve({
		reservationId: "hosting:operation",
		requestDigest: quote.requestDigest,
		quote,
		identity: current.identity,
		expectedSeq: current.seq,
		now: NOW,
	});
}

describe("CI bridge to the shared hosting financial authority", () => {
	it("refuses an in-memory parent", () => {
		expect(() =>
			createCiSharedBudgetHooks({
				authority: createBudgetAdmissionAuthority({ snapshot: snapshot() }),
				quoteLease,
			}),
		).toThrow("durable parent");
	});
	it("uses stable job identity and separates the hosting namespace", () => {
		const first = lease();
		const retry = clone(LeaseSchema, first);
		retry.id = "different-random-id";
		expect(ciReservationId(first)).toBe(ciReservationId(retry));
		expect(ciReservationId(first)).toMatch(/^ci:sha256:/);
		retry.runAttempt++;
		expect(ciReservationId(first)).not.toBe(ciReservationId(retry));
	});
	it("supports native pipelines with no GitHub identity", () => {
		const row = lease();
		row.pipelineId = "pipeline-execution-1";
		row.pipelineDigest = "immutable-plan";
		row.jobId = 0;
		row.originalRunId = 0;
		row.installationId = 0;
		row.repositoryId = 0;
		row.repository = "";
		const { first } = durable();
		expect(
			createCiSharedBudgetHooks({ authority: first, quoteLease }).reserve(row)
				.status,
		).toBe("held");
	});
	it.each([
		true,
		false,
	])("competes with hosting for the same final100 headroom (CI first=%s)", (ciFirst) => {
		const { first, second } = durable();
		const hooks = createCiSharedBudgetHooks({ authority: first, quoteLease });
		if (ciFirst) {
			hooks.reserve(lease());
			expect(() => hosting(second, 60)).toThrow(/budget exhausted/);
		} else {
			hosting(second, 60);
			expect(() => hooks.reserve(lease())).toThrow(/budget.policy.exhausted/);
		}
		expect(second.read(NOW).reservedMicros).toBe(60);
	});
	it("permits exact exhaustion across independent authority connections", () => {
		const { first, second } = durable();
		createCiSharedBudgetHooks({ authority: first, quoteLease }).reserve(
			lease(),
		);
		hosting(second, 40);
		expect(first.read(NOW).reservedMicros).toBe(100);
	});
	it("retains an orphan parent hold after a failed independent lease commit", () => {
		const { first, second } = durable();
		const row = lease();
		const hooks = createCiSharedBudgetHooks({ authority: first, quoteLease });
		hooks.reserve(row);
		hooks.uncertain(row);
		expect(second.lookup(ciReservationId(row))?.status).toBe("uncertain");
		expect(() => hooks.releaseUnused(row, "missing-row-or-deadline")).toThrow(
			"cancelled-before-claim",
		);
		expect(second.read(NOW).reservedMicros).toBe(60);
	});
	it("checks per-work ceilings against the complete quoted liability", () => {
		const { first } = durable();
		const row = lease();
		row.reservedPaidMicros = 80;
		row.budgetPolicyDigest = canonicalBudgetPolicyJson(
			parseBudgetPolicyJson(
				JSON.stringify({
					...parseBudgetPolicyJson(policy()),
					constraints: [
						{
							key: "work.cost",
							workload: "ci",
							unit: "USD.micros",
							maximum: 70,
						},
					],
				}),
			),
		);
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease: (candidate) => {
				const quote = quoteLease(candidate);
				quote.liabilityBoundMicros = 80;
				const account = quote.providerAccounts[0];
				if (!account) throw new Error("fixture");
				account.liabilityMicros = 80;
				return quote;
			},
		});
		expect(() => hooks.reserve(row)).toThrow("work.cost");
		expect(first.read(NOW).reservedMicros).toBe(0);
	});
	it("checks narrower provider ceilings against existing parent exposure and actual liability", () => {
		const { first, second } = durable();
		hosting(second, 20);
		const row = lease();
		row.reservedPaidMicros = 80;
		row.budgetPolicyDigest = canonicalBudgetPolicyJson(
			parseBudgetPolicyJson(
				JSON.stringify({
					...parseBudgetPolicyJson(policy()),
					constraints: [
						{
							key: "provider.cost",
							workload: "ci",
							unit: "USD.micros",
							target: "native:account",
							maximum: 90,
						},
					],
				}),
			),
		);
		expect(() =>
			createCiSharedBudgetHooks({
				authority: first,
				quoteLease: (candidate) => {
					const quote = quoteLease(candidate);
					quote.liabilityBoundMicros = 80;
					const account = quote.providerAccounts[0];
					if (!account) throw new Error("fixture");
					account.liabilityMicros = 80;
					return quote;
				},
			}).reserve(row),
		).toThrow("provider.cost");
		expect(first.read(NOW).reservedMicros).toBe(20);
	});
	it("refuses unknown required provider dimensions and invented caller financial metrics", () => {
		const { first } = durable();
		const row = lease();
		row.budgetPolicyDigest = canonicalBudgetPolicyJson(
			parseBudgetPolicyJson(
				JSON.stringify({
					...parseBudgetPolicyJson(policy()),
					constraints: [
						{
							key: "provider.cost",
							workload: "ci",
							unit: "USD.micros",
							target: "unobserved-account",
							maximum: 90,
						},
					],
				}),
			),
		);
		const hooks = createCiSharedBudgetHooks({ authority: first, quoteLease });
		expect(() => hooks.reserve(row)).toThrow("required metric is unavailable");
		expect(() =>
			hooks.reserve(row, [
				{
					key: "provider.cost",
					unit: "USD.micros",
					target: "unobserved-account",
					value: 0,
				},
			]),
		).toThrow("cannot supply quote-derived");
	});
	it("requires actual store-owned local constraint measurements", () => {
		const { first } = durable();
		const row = lease();
		row.budgetPolicyDigest = canonicalBudgetPolicyJson(
			parseBudgetPolicyJson(
				JSON.stringify({
					...parseBudgetPolicyJson(policy()),
					constraints: [
						{
							key: "work.concurrent",
							workload: "ci",
							unit: "count",
							maximum: 1,
						},
					],
				}),
			),
		);
		const hooks = createCiSharedBudgetHooks({ authority: first, quoteLease });
		expect(() => hooks.reserve(row)).toThrow("required metric is unavailable");
		hooks.reserve(row, [{ key: "work.concurrent", unit: "count", value: 1 }]);
		expect(() =>
			hooks.claim(row, [{ key: "work.concurrent", unit: "count", value: 2 }]),
		).toThrow("work.concurrent");
		expect(
			hooks.claim(row, [{ key: "work.concurrent", unit: "count", value: 1 }])
				.executionDigest,
		).not.toBe("");
	});
	it("rechecks financial policy before claim after another workload reports an actual overrun", () => {
		const { first, second } = durable();
		const row = lease();
		const hooks = createCiSharedBudgetHooks({ authority: first, quoteLease });
		hooks.reserve(row);
		hosting(second, 20);
		second.settle("hosting:operation", 60, {
			usageEvidenceRef: "native:overrun",
			sourceStoppedEvidenceRef: "native:retired",
			providerAccounts: [
				{ providerAccountId: "native:account", liabilityMicros: 60 },
			],
		});
		expect(() => hooks.claim(row)).toThrow("budget.policy.exhausted");
		expect(first.lookup(ciReservationId(row))?.executionDigest).toBe("");
	});
	it("requires native scope/amount/time/incarnation evidence for strict admission", () => {
		const { first } = durable();
		const row = lease();
		row.budgetPolicyDigest = policy("strict");
		expect(() =>
			createCiSharedBudgetHooks({ authority: first, quoteLease }).reserve(row),
		).toThrow("trustworthy provider liability bound");
		expect(first.read(NOW).reservedMicros).toBe(0);
	});
	it("revalidates the pinned strict bound before the first provider effect", () => {
		const { first } = durable();
		const row = lease();
		row.budgetPolicyDigest = policy("strict");
		let valid = true;
		const checks: string[] = [];
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			verifyProviderLiabilityBound: (candidate, quote, at) => {
				checks.push(at);
				return (
					valid &&
					candidate.providerAccountId === "native:account" &&
					quote.liabilityBoundMicros === 60
				);
			},
			now: () => NOW,
		});
		hooks.reserve(row);
		valid = false;
		expect(() => hooks.claim(row)).toThrow(
			"trustworthy provider liability bound",
		);
		expect(checks).toEqual([NOW, NOW]);
		expect(first.lookup(ciReservationId(row))?.executionDigest).toBe("");
	});
	it("refuses a strict-to-conservative host override", () => {
		const { first } = durable();
		const row = lease();
		row.budgetPolicyDigest = policy("strict");
		expect(() =>
			createCiSharedBudgetHooks({
				authority: first,
				quoteLease,
				mode: "conservative",
			}).reserve(row),
		).toThrow("pinned common budget policy");
	});
	it.each([
		"quote",
		"window",
		"native-bound",
	])("refuses provider IO when %s expires inside the committed parent claim", (scope) => {
		const { first } = durable();
		const row = lease();
		let now = NOW;
		let nativeValid = true;
		let providerEffects = 0;
		row.budgetPolicyDigest =
			scope === "window"
				? canonicalBudgetPolicyJson(
						parseBudgetPolicyJson(
							JSON.stringify({
								...parseBudgetPolicyJson(policy("strict")),
								periodKind: "fixed-window",
								periodStartsAtMs: Date.parse(NOW) - 1,
								periodEndsAtMs: Date.parse(NOW) + 60000,
							}),
						),
					)
				: policy("strict");
		const authority = {
			...first,
			claimExecution(command: Parameters<typeof first.claimExecution>[0]) {
				const receipt = first.claimExecution(command);
				if (scope === "quote") now = UNTIL;
				if (scope === "window") now = "2026-10-30T12:01:01Z";
				if (scope === "native-bound") nativeValid = false;
				return receipt;
			},
		};
		const hooks = createCiSharedBudgetHooks({
			authority,
			quoteLease,
			now: () => now,
			verifyProviderLiabilityBound: () => nativeValid,
		});
		hooks.reserve(row);
		expect(() => {
			hooks.claim(row);
			providerEffects++;
		}).toThrow(
			/stale|pinned common budget policy|trustworthy provider liability bound/,
		);
		expect(providerEffects).toBe(0);
		expect(first.lookup(ciReservationId(row))?.executionDigest).toBe(
			ciExecutionDigest(row),
		);
		expect(first.read(NOW).reservedMicros).toBe(60);
	});
	it("exposes only definitive precommit policy denial as a queueable budget error", () => {
		const { first } = durable();
		const row = lease();
		row.budgetPolicyDigest = canonicalBudgetPolicyJson(
			parseBudgetPolicyJson(
				JSON.stringify({
					...parseBudgetPolicyJson(policy()),
					constraints: [
						{
							key: "work.cost",
							workload: "ci",
							unit: "USD.micros",
							maximum: 0,
						},
					],
				}),
			),
		);
		const hooks = createCiSharedBudgetHooks({ authority: first, quoteLease });
		expect(() => hooks.reserve(row)).toThrow(BudgetAdmissionDeniedError);
		expect(first.read(NOW).reservedMicros).toBe(0);
	});
	it("refuses launch after pinned quote expiry", () => {
		const { first } = durable();
		let now = NOW;
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			now: () => now,
		});
		const row = lease();
		hooks.reserve(row);
		now = UNTIL;
		expect(() => hooks.claim(row)).toThrow("stale");
		expect(first.read(NOW).reservedMicros).toBe(60);
	});
	it("refuses a refreshed or altered quote under an existing financial hold", () => {
		const { first } = durable();
		let changed = false;
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease: (row) => {
				const quote = quoteLease(row);
				if (changed) quote.quoteId = "replacement";
				return quote;
			},
		});
		const row = lease();
		hooks.reserve(row);
		changed = true;
		expect(() => hooks.claim(row)).toThrow("pinned admission");
	});
	it("pins complete financial terms rather than allowing duration or payer substitution", () => {
		const { first } = durable();
		const row = lease();
		const hooks = createCiSharedBudgetHooks({ authority: first, quoteLease });
		hooks.reserve(row);
		for (const change of [
			(candidate: Lease) => {
				candidate.reservedMinutes = 2;
			},
			(candidate: Lease) => {
				candidate.providerAccountId = "other";
			},
			(candidate: Lease) => {
				candidate.budgetPeriodId = "p2";
			},
			(candidate: Lease) => {
				candidate.priceMicrosPerMinute = 1;
			},
		]) {
			const changed = clone(LeaseSchema, row);
			change(changed);
			expect(() => hooks.claim(changed)).toThrow("exact original");
		}
	});
	it("does not accept a trusted quote that omits the pinned shared credit claim", () => {
		const { first } = durable();
		const row = lease();
		row.reservedFreeMinutes = 1;
		expect(() =>
			createCiSharedBudgetHooks({
				authority: first,
				quoteLease: (entry) => {
					const q = quoteLease(entry);
					q.entitlementClaims = [];
					return q;
				},
			}).reserve(row),
		).toThrow("credit claims");
	});
	it("refuses a policy limit that disagrees with the shared parent", () => {
		const { first } = durable();
		const row = lease();
		row.budgetPolicyDigest = policy("conservative", 1000);
		expect(() =>
			createCiSharedBudgetHooks({ authority: first, quoteLease }).reserve(row),
		).toThrow("policy limit differs");
	});
	it("claims once for one concrete execution and never releases an ambiguous claimed effect", () => {
		const { first } = durable();
		const row = lease();
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			verifyUnused: () => true,
		});
		hooks.reserve(row);
		const claimed = hooks.claim(row);
		expect(hooks.claim(row).executionDigest).toBe(claimed.executionDigest);
		const copied = clone(LeaseSchema, row);
		copied.id = "competing-lease";
		expect(() => hooks.claim(copied)).toThrow("another execution");
		hooks.uncertain(row);
		row.state = "cancelled";
		expect(() => hooks.releaseUnused(row, "durable-cancel-cas")).toThrow(
			"cancelled-before-claim",
		);
		expect(first.read(NOW).reservedMicros).toBe(60);
	});
	it("releases preallocation only with durable cancellation proof before execution claim", () => {
		const { first } = durable();
		const row = lease();
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			verifyUnused: (_, ref) => ref === "cancel-journal:cas:1",
		});
		hooks.reserve(row);
		row.state = "cancelled";
		expect(() => hooks.releaseUnused(row, "404")).toThrow("CAS evidence");
		expect(hooks.releaseUnused(row, "cancel-journal:cas:1").status).toBe(
			"released",
		);
		expect(first.read(NOW).reservedMicros).toBe(0);
	});
	it("keeps the hold if execution wins the race after unused-proof lookup", () => {
		const { first, second } = durable();
		const row = lease();
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			verifyUnused: () => {
				second.claimExecution({
					reservationId: ciReservationId(row),
					requestDigest: ciRequestDigest(row),
					executionDigest: ciExecutionDigest(row),
				});
				return true;
			},
		});
		hooks.reserve(row);
		row.state = "cancelled";
		expect(() => hooks.releaseUnused(row, "durable-cancel-proof")).toThrow(
			/execution|claimed/,
		);
		expect(first.read(NOW).reservedMicros).toBe(60);
	});
	it("retains parent liability when only elapsed-time or stop-ACK evidence exists", () => {
		const { first } = durable();
		const row = lease();
		const hooks = createCiSharedBudgetHooks({ authority: first, quoteLease });
		hooks.reserve(row);
		hooks.claim(row);
		row.paidMicros = 0;
		expect(() =>
			hooks.settle(row, {
				usageEvidenceRef: "elapsed-time",
				sourceStoppedEvidenceRef: "delete204",
			}),
		).toThrow("native final usage");
		expect(first.read(NOW).reservedMicros).toBe(60);
	});
	it("records a proven actual overrun against the original payer instead of dropping it", () => {
		const { first } = durable();
		const row = lease();
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			verifyFinalUsage: (_, evidence) =>
				evidence.usageEvidenceRef === "native:final-ledger" &&
				evidence.sourceStoppedEvidenceRef === "native:stopped",
		});
		hooks.reserve(row);
		hooks.claim(row);
		row.paidMicros = 120;
		hooks.settle(row, {
			usageEvidenceRef: "native:final-ledger",
			sourceStoppedEvidenceRef: "native:stopped",
			providerAccounts: [
				{ providerAccountId: "native:account", liabilityMicros: 120 },
			],
		});
		expect(first.read(NOW)).toMatchObject({
			spentMicros: 120,
			reservedMicros: 0,
		});
	});
	it("requires final credit usage rows, including zero, and rejects foreign payer evidence", () => {
		const { first } = durable();
		const row = lease();
		row.reservedFreeMinutes = 1;
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			verifyAllocationCoverage: runnerCoverage,
			verifyFinalUsage: () => true,
		});
		hooks.reserve(row);
		hooks.claim(row);
		row.paidMicros = 20;
		const evidence = {
			usageEvidenceRef: "native:usage",
			sourceStoppedEvidenceRef: "native:stop",
			providerAccounts: [
				{ providerAccountId: "native:account", liabilityMicros: 20 },
			],
		};
		expect(() => hooks.settle(row, evidence)).toThrow(
			"complete account and entitlement",
		);
		expect(() =>
			hooks.settle(row, {
				...evidence,
				providerAccounts: [
					{ providerAccountId: "foreign", liabilityMicros: 20 },
				],
				entitlementClaims: [
					{ bucketId: "shared-credit", unit: "micro-minutes", units: 0 },
				],
			}),
		).toThrow("foreign provider");
		hooks.settle(row, {
			...evidence,
			entitlementClaims: [
				{ bucketId: "shared-credit", unit: "micro-minutes", units: 0 },
			],
		});
		expect(first.read(NOW).spentMicros).toBe(20);
	});
	it("requires a native unit-coverage verifier rather than accepting a nonempty credit claim", () => {
		const { first } = durable();
		const row = lease();
		row.reservedFreeMinutes = 1;
		expect(() =>
			createCiSharedBudgetHooks({ authority: first, quoteLease }).reserve(row),
		).toThrow("allocation coverage");
		expect(first.read(NOW).reservedMicros).toBe(0);
	});
	it("rejects understated runner allocation units", () => {
		const { first } = durable();
		const row = lease();
		row.reservedFreeMinutes = 1;
		expect(() =>
			createCiSharedBudgetHooks({
				authority: first,
				verifyAllocationCoverage: runnerCoverage,
				quoteLease: (candidate) => {
					const quote = quoteLease(candidate);
					const claim = quote.entitlementClaims[0];
					if (!claim) throw new Error("fixture");
					claim.units = 1;
					return quote;
				},
			}).reserve(row),
		).toThrow("allocation coverage");
	});
	it("rejects a mismatched parent bucket unit even when a publisher claims coverage", () => {
		const { first } = durable();
		const row = lease();
		row.reservedFreeMinutes = 1;
		expect(() =>
			createCiSharedBudgetHooks({
				authority: first,
				verifyAllocationCoverage: () => true,
				quoteLease: (candidate) => {
					const quote = quoteLease(candidate);
					const claim = quote.entitlementClaims[0];
					if (!claim) throw new Error("fixture");
					claim.unit = "USD.micros";
					return quote;
				},
			}).reserve(row),
		).toThrow("original parent bucket and unit");
	});
	it("reserves complete fractional runner allocation in explicitly scaled parent units", () => {
		const { first } = durable();
		const row = lease();
		row.reservedFreeMinutes = 0.125;
		const hooks = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			verifyAllocationCoverage: runnerCoverage,
		});
		hooks.reserve(row);
		hooks.claim(row);
		expect(first.read(NOW).entitlements[0]?.reservedUnits).toBe(125000);
	});
	it.each([
		{ cpuVcpuMs: 1 },
		{ memoryMbMs: 1 },
		{ egressBytes: 1 },
		{ creations: 1 },
		{ proxyBytes: 1 },
		{ proxySessions: 1 },
		{ proxyControlCalls: 1 },
	])("refuses unproven Sandbox allocation coverage for %j", (allowance) => {
		const { first } = durable();
		const row = lease();
		row.sandboxReservedAllowance = create(SandboxAllowanceSchema, allowance);
		expect(() =>
			createCiSharedBudgetHooks({ authority: first, quoteLease }).reserve(row),
		).toThrow("allocation coverage");
	});
	it("settles late native usage against the original payer after both policy window and quote expire", () => {
		const { first, path } = durable();
		const row = lease();
		row.budgetPolicyDigest = canonicalBudgetPolicyJson(
			parseBudgetPolicyJson(
				JSON.stringify({
					...parseBudgetPolicyJson(policy("strict")),
					periodKind: "fixed-window",
					periodStartsAtMs: Date.parse(NOW) - 1,
					periodEndsAtMs: Date.parse(NOW) + 60000,
				}),
			),
		);
		const before = createCiSharedBudgetHooks({
			authority: first,
			quoteLease,
			verifyProviderLiabilityBound: () => true,
		});
		before.reserve(row);
		before.claim(row);
		const late = "2026-11-01T12:00:00Z";
		const reopened = createSqliteBudgetAdmissionAuthority({
			path,
			snapshot: snapshot(),
			now: () => late,
		});
		cleanup.push(() => reopened.close());
		const after = createCiSharedBudgetHooks({
			authority: reopened,
			quoteLease,
			now: () => late,
			verifyProviderLiabilityBound: () => false,
			verifyFinalUsage: (_, evidence) =>
				evidence.usageEvidenceRef === "native:late-invoice",
		});
		row.paidMicros = 25;
		expect(
			after.settle(row, {
				usageEvidenceRef: "native:late-invoice",
				sourceStoppedEvidenceRef: "native:retired",
				providerAccounts: [
					{ providerAccountId: "native:account", liabilityMicros: 25 },
				],
			}),
		).toMatchObject({
			status: "settled",
			actualMicros: 25,
			identity: {
				tenantId: "tenant",
				budgetId: "shared",
				periodId: "p1",
				policyRevision: "v1",
			},
		});
		expect(first.read(NOW)).toMatchObject({
			spentMicros: 25,
			reservedMicros: 0,
		});
	});
});

it.skipIf(!process.env.HOBO_TEST_POSTGRES_URL)(
	"uses async CI hooks and hosting against one real PostgreSQL balance",
	async () => {
		const pool = new Pool({
			connectionString: process.env.HOBO_TEST_POSTGRES_URL,
		});
		const otherPool = new Pool({
			connectionString: process.env.HOBO_TEST_POSTGRES_URL,
		});
		livePools.push(pool, otherPool);
		const base = snapshot();
		if (!base.identity) throw new Error("fixture identity missing");
		base.identity.budgetId = randomUUID();
		const row = lease();
		row.budgetId = base.identity.budgetId;
		row.budgetPolicyDigest = canonicalBudgetPolicyJson(
			parseBudgetPolicyJson(
				JSON.stringify({
					...parseBudgetPolicyJson(policy("strict")),
					budgetId: row.budgetId,
				}),
			),
		);
		const parent = createPostgresBudgetAdmissionAuthority({
			pool,
			snapshot: base,
			now: () => NOW,
		});
		const hostingParent = createPostgresBudgetAdmissionAuthority({
			pool: otherPool,
			snapshot: base,
			now: () => NOW,
		});
		let boundValid = true;
		const hooks = createCiAsyncSharedBudgetHooks({
			authority: parent,
			quoteLease,
			now: () => NOW,
			verifyProviderLiabilityBound: () => boundValid,
			verifyFinalUsage: (_, evidence) =>
				evidence.usageEvidenceRef === "native:final",
		});
		await hooks.reserve(row);
		boundValid = false;
		await expect(hooks.claim(row)).rejects.toThrow(
			"trustworthy provider liability bound",
		);
		boundValid = true;
		await hooks.claim(row);
		const copied = clone(LeaseSchema, row);
		copied.id = "other-execution";
		await expect(hooks.claim(copied)).rejects.toThrow("another execution");
		const current = await hostingParent.read(NOW);
		if (!current.identity) throw new Error("fixture identity missing");
		const quote = create(HostingQuoteSchema, {
			quoteId: "hosting",
			yardId: "yard",
			providerId: "github",
			ownerTenantId: "tenant",
			currency: "USD",
			totalMicros: 40,
			liabilityBoundMicros: 40,
			requestDigest: "hosting",
			observedAt: NOW,
			validUntil: UNTIL,
			components: [{ name: "complete", costMicros: 40 }],
			providerAccounts: [
				{ providerAccountId: "native:account", liabilityMicros: 40 },
			],
		});
		await hostingParent.reserve({
			reservationId: "hosting:other",
			requestDigest: "hosting",
			quote,
			identity: current.identity,
			expectedSeq: current.seq,
			now: NOW,
		});
		expect((await parent.read(NOW)).reservedMicros).toBe(100);
		await hooks.uncertain(row);
		row.paidMicros = 80;
		await hooks.settle(row, {
			usageEvidenceRef: "native:final",
			sourceStoppedEvidenceRef: "native:stop",
			providerAccounts: [
				{ providerAccountId: "native:account", liabilityMicros: 80 },
			],
		});
		expect(await hostingParent.read(NOW)).toMatchObject({
			spentMicros: 80,
			reservedMicros: 40,
		});
	},
);

it.skipIf(!process.env.HOBO_TEST_POSTGRES_URL)(
	"keeps an async committed parent hold when the quote expires during its claim",
	async () => {
		const pool = new Pool({
			connectionString: process.env.HOBO_TEST_POSTGRES_URL,
		});
		livePools.push(pool);
		const base = snapshot();
		if (!base.identity) throw new Error("fixture identity missing");
		base.identity.budgetId = randomUUID();
		const row = lease();
		row.budgetId = base.identity.budgetId;
		row.budgetPolicyDigest = canonicalBudgetPolicyJson(
			parseBudgetPolicyJson(
				JSON.stringify({
					...parseBudgetPolicyJson(policy("strict")),
					budgetId: row.budgetId,
				}),
			),
		);
		const parent = createPostgresBudgetAdmissionAuthority({
			pool,
			snapshot: base,
			now: () => NOW,
		});
		let now = NOW;
		let effects = 0;
		const delayed = {
			...parent,
			async claimExecution(
				command: Parameters<typeof parent.claimExecution>[0],
			) {
				const receipt = await parent.claimExecution(command);
				now = UNTIL;
				return receipt;
			},
		};
		const hooks = createCiAsyncSharedBudgetHooks({
			authority: delayed,
			quoteLease,
			now: () => now,
			verifyProviderLiabilityBound: () => true,
		});
		await hooks.reserve(row);
		await expect(
			(async () => {
				await hooks.claim(row);
				effects++;
			})(),
		).rejects.toThrow("stale");
		expect(effects).toBe(0);
		expect((await parent.lookup(ciReservationId(row)))?.executionDigest).toBe(
			ciExecutionDigest(row),
		);
		expect((await parent.read(NOW)).reservedMicros).toBe(60);
	},
);
