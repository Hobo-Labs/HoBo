import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "@hobo/broker";
import { afterEach, describe, expect, it } from "vitest";
import {
	AccountSchema,
	ConfigurationSchema,
	ConnectionSchema,
	JobSchema,
	type Lease,
	OfferSchema,
} from "../src/_generated/ci_pb.js";
import {
	ciFinancialPlanHash,
	ciRequestDigest,
	ciReservationId,
	createCiSharedBudgetHooks,
} from "../src/shared-budget.js";
import { SqliteCiStore } from "../src/sqlite-store.js";

const NOW = "2026-10-30T12:00:00Z";
const UNTIL = "2026-10-31T00:00:00Z";
const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const close of cleanup.splice(0).reverse()) close();
});
function setup() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-sqlite-parent-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	const parent = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "parent.sqlite"),
		now: () => NOW,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "shared",
				periodId: "p1",
				policyRevision: "r1",
			},
			limitMicros: 300,
			observedAt: NOW,
			validUntil: UNTIL,
			providerAccounts: [{ providerAccountId: "owned", limitMicros: 300 }],
		}),
	});
	cleanup.push(() => parent.close());
	const account = create(AccountSchema, {
		id: "ci",
		budgetMicros: 300,
		maxRuntimeMinutes: 1,
		startupMinutes: 1,
		budgetPolicy: {
			schemaVersion: "hobo.budget-policy/v1",
			tenantId: "tenant",
			budgetId: "shared",
			periodId: "p1",
			revision: "r1",
			workloads: ["hosting", "ci"],
			currency: "USD",
			limitMicros: 300,
			objective: "min-cost",
			enforcement: "conservative",
			periodKind: "manual",
			constraints: [
				{ key: "ci.attempts", workload: "ci", unit: "count", maximum: 3 },
				{
					key: "ci.queue.duration",
					workload: "ci",
					unit: "ms",
					maximum: 60000,
				},
			],
		},
		offers: [
			create(OfferSchema, {
				id: "native",
				provider: "github",
				providerAccountId: "owned",
				budgetMicros: 300,
				priceMicrosPerMinute: 100,
				concurrency: 10,
				enabled: true,
				bridgeAcknowledged: true,
				runsOn: "ubuntu-24.04",
				observedAt: NOW,
				validUntil: UNTIL,
				sourceUrl: "https://example.test/usage",
			}),
		],
	});
	const config = create(ConfigurationSchema, {
		accounts: [account],
		connections: [
			create(ConnectionSchema, {
				accountId: "ci",
				repository: "Org/Repo",
				repositoryId: 101,
				installationId: 10,
				runnerGroupId: 1,
				bridgeWorkflow: "hobo-ci-host.yml",
				bridgeRef: "hobo-ci-v1",
				bridgeSha: "0".repeat(40),
				dispatcherActorId: 1,
				allowedEvents: ["push"],
				allowedRefs: ["refs/heads/main"],
				trustedRepositoryAcknowledged: true,
			}),
		],
	});
	const job = create(JobSchema, {
		id: 123,
		runId: 456,
		runAttempt: 1,
		repositoryId: 101,
		installationId: 10,
		repository: "Org/Repo",
		labels: ["hobo"],
		action: "queued",
	});
	const quoteLease = (lease: Lease) =>
		create(HostingQuoteSchema, {
			quoteId: `quote:${ciReservationId(lease)}`,
			yardId: `ci:${lease.accountId}`,
			providerId: lease.provider,
			ownerTenantId: lease.budgetTenantId,
			currency: "USD",
			totalMicros: lease.reservedPaidMicros,
			liabilityBoundMicros: lease.reservedPaidMicros,
			observedAt: NOW,
			validUntil: UNTIL,
			components: [{ name: "native", costMicros: lease.reservedPaidMicros }],
			requestDigest: ciRequestDigest(lease),
			financialPlanHash: ciFinancialPlanHash(lease),
			providerAccounts: [
				{
					providerAccountId: lease.providerAccountId,
					liabilityMicros: lease.reservedPaidMicros,
				},
			],
		});
	const hooks = createCiSharedBudgetHooks({
		authority: parent,
		quoteLease,
		now: () => NOW,
		verifyUnused: (_lease, proof) => proof === "verified-unused",
		verifyFinalUsage: (_lease, proof) =>
			proof.usageEvidenceRef === "final" &&
			proof.sourceStoppedEvidenceRef === "stopped",
	});
	const store = new SqliteCiStore(join(dir, "ci.sqlite"), {
		sharedBudget: hooks,
	});
	cleanup.push(() => store.close());
	return { store, parent, account, config, job, dir };
}

describe("hosted SQLite cross-ledger failure recovery", () => {
	it("recovers the admitted parent hold after a lost reservation acknowledgement", async () => {
		const { store, account, config, job, parent } = setup();
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const original = parent.reserve.bind(parent);
		let failOnce = true;
		parent.reserve = (input) => {
			const receipt = original(input);
			if (failOnce) {
				failOnce = false;
				throw new Error("lost-successful-parent-response");
			}
			return receipt;
		};
		await expect(store.reserve(account, job, NOW)).rejects.toThrow(
			"lost-successful-parent-response",
		);
		expect(parent.read(NOW).reservedMicros).toBe(200);
		const recovered = await store.reserve(account, job, NOW);
		expect(recovered?.budgetAdmissionAttempt).toBe(1);
		expect(parent.read(NOW).reservedMicros).toBe(200);
		const duplicate = await store.reserve(account, job, NOW);
		expect(duplicate?.id).toBe(recovered?.id);
	});
	it("recovers a lost parent-claim acknowledgement without a duplicate claim", async () => {
		const { store, account, config, job, parent } = setup();
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		if (!lease) throw new Error("missing lease");
		const original = parent.claimExecution.bind(parent);
		let failOnce = true;
		parent.claimExecution = (input) => {
			const receipt = original(input);
			if (failOnce) {
				failOnce = false;
				throw new Error("lost-successful-claim-response");
			}
			return receipt;
		};
		const dispatch = () =>
			store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "dispatching";
				},
				"ci.DispatchRequested",
				NOW,
			);
		await expect(dispatch()).rejects.toThrow("lost-successful-claim-response");
		expect((await store.get(lease.id))?.state).toBe("reserved");
		expect(parent.lookup(ciReservationId(lease))?.executionDigest).not.toBe("");
		expect((await dispatch())?.state).toBe("dispatching");
		expect(parent.read(NOW).reservedMicros).toBe(200);
	});
	it("cannot release a parent-claimed hold after a lost claim and local cancellation", async () => {
		const { store, account, config, job, parent } = setup();
		await store.configure(config, 0, NOW);
		await store.queue(job, NOW);
		const lease = await store.reserve(account, job, NOW);
		if (!lease) throw new Error("missing lease");
		const original = parent.claimExecution.bind(parent);
		parent.claimExecution = (input) => {
			original(input);
			throw new Error("lost-successful-claim-response");
		};
		await expect(
			store.transition(
				lease.id,
				["reserved"],
				(entry) => {
					entry.state = "dispatching";
				},
				"ci.DispatchRequested",
				NOW,
			),
		).rejects.toThrow();
		await store.cancelAndRequeue(lease.id, job, NOW);
		await expect(
			store.releaseUnusedSharedBudget(lease.id, "verified-unused", NOW),
		).rejects.toThrow();
		expect(parent.read(NOW).reservedMicros).toBe(200);
	});
});
