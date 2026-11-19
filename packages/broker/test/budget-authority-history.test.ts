import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clone, create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BudgetAuthorityEvent,
	BudgetAuthorityEventSchema,
	BudgetEntitlementSchema,
	BudgetLedgerSnapshotSchema,
	createBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "../src/budget-authority.js";
import { createSqliteBudgetAdmissionAuthority } from "../src/budget-sqlite.js";

const NOW = "2026-10-30T12:00:00Z";
const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});
function snapshot() {
	return create(BudgetLedgerSnapshotSchema, {
		identity: {
			tenantId: "tenant",
			budgetId: "shared",
			periodId: "p1",
			policyRevision: "v1",
		},
		limitMicros: 100,
		observedAt: "2026-10-30T00:00:00Z",
		validUntil: "2026-10-31T00:00:00Z",
		entitlements: [
			{
				bucketId: "credit",
				kind: "credit",
				unit: "micros",
				periodId: "p1",
				remainingUnits: 10,
				observedAt: "2026-10-30T00:00:00Z",
				validUntil: "2026-10-31T00:00:00Z",
			},
		],
	});
}
function multiUnitSnapshot() {
	const base = snapshot();
	const bucket = base.entitlements[0];
	if (!bucket) throw new Error("fixture bucket missing");
	base.entitlements = (["request", "runner-ms"] as const).map((unit, index) =>
		create(BudgetEntitlementSchema, {
			...bucket,
			bucketId: "shared",
			kind: "allowance",
			unit,
			remainingUnits: (index + 1) * 10,
		}),
	);
	return base;
}
function consume(authority: ReturnType<typeof createBudgetAdmissionAuthority>) {
	const current = authority.read(NOW);
	if (!current.identity) throw new Error("fixture identity missing");
	const quote = create(HostingQuoteSchema, {
		quoteId: "quote",
		yardId: "yard",
		providerId: "provider",
		ownerTenantId: "tenant",
		currency: "USD",
		totalMicros: 0,
		liabilityBoundMicros: 0,
		observedAt: "2026-10-30T00:00:00Z",
		validUntil: "2026-10-31T00:00:00Z",
		components: [{ name: "usage", costMicros: 0 }],
		requestDigest: "request",
		entitlementClaims: [
			{ bucketId: "credit", kind: "credit", unit: "micros", units: 10 },
		],
	});
	authority.reserve({
		reservationId: "work",
		requestDigest: quote.requestDigest,
		quote,
		identity: current.identity,
		expectedSeq: current.seq,
		now: NOW,
	});
	authority.settle("work", 0, {
		usageEvidenceRef: "final-usage",
		sourceStoppedEvidenceRef: "stopped",
		entitlementClaims: quote.entitlementClaims,
	});
}

describe("durable budget history fences", () => {
	it("retires period identity across policy revisions without blocking fresh periods", () => {
		const base = snapshot();
		base.spentMicros = 100;
		const authority = createBudgetAdmissionAuthority({ snapshot: base });
		const p2 = snapshot();
		if (!p2.identity) throw new Error("fixture identity missing");
		p2.identity.periodId = "p2";
		authority.configure(p2, 0, NOW);
		const revived = snapshot();
		if (!revived.identity) throw new Error("fixture identity missing");
		revived.identity.policyRevision = "v2";
		expect(() => authority.configure(revived, 1, NOW)).toThrow(
			"retired period",
		);
		expect(authority.read(NOW).seq).toBe(1);
		const revised = authority.read(NOW);
		if (!revised.identity) throw new Error("fixture identity missing");
		revised.identity.policyRevision = "v2";
		revised.limitMicros = 200;
		authority.configure(revised, 1, NOW);
		const p3 = snapshot();
		if (!p3.identity) throw new Error("fixture identity missing");
		p3.identity.periodId = "p3";
		authority.configure(p3, 2, NOW);
		expect(authority.read(NOW)).toMatchObject({
			identity: { periodId: "p3" },
			spentMicros: 0,
		});
		expect(() => authority.configure(p2, 3, NOW)).toThrow("retired period");
	});

	it("reconstructs retired periods through independent SQLite connections and reopening", () => {
		const directory = mkdtempSync(
			join(tmpdir(), "hobo-budget-period-history-"),
		);
		directories.push(directory);
		const path = join(directory, "budget.sqlite");
		const options = { path, snapshot: snapshot(), now: () => NOW };
		const first = createSqliteBudgetAdmissionAuthority(options);
		const second = createSqliteBudgetAdmissionAuthority(options);
		try {
			const p2 = snapshot();
			if (!p2.identity) throw new Error("fixture identity missing");
			p2.identity.periodId = "p2";
			first.configure(p2, 0, NOW);
			expect(() => second.configure(snapshot(), 1, NOW)).toThrow(
				"retired period",
			);
		} finally {
			first.close();
			second.close();
		}
		const reopened = createSqliteBudgetAdmissionAuthority(options);
		try {
			expect(() => reopened.configure(snapshot(), 1, NOW)).toThrow(
				"retired period",
			);
			const p3 = snapshot();
			if (!p3.identity) throw new Error("fixture identity missing");
			p3.identity.periodId = "p3";
			reopened.configure(p3, 1, NOW);
			expect(reopened.read(NOW).identity?.periodId).toBe("p3");
		} finally {
			reopened.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("preserves settled bucket depletion through removal, independent writers and reopening", () => {
		const directory = mkdtempSync(
			join(tmpdir(), "hobo-budget-bucket-history-"),
		);
		directories.push(directory);
		const path = join(directory, "budget.sqlite");
		const options = { path, snapshot: snapshot(), now: () => NOW };
		const first = createSqliteBudgetAdmissionAuthority(options);
		const second = createSqliteBudgetAdmissionAuthority(options);
		let removedSeq: number;
		try {
			consume(first);
			const removed = second.read(NOW);
			expect(removed.entitlements[0]?.remainingUnits).toBe(0);
			removed.entitlements = [];
			second.configure(removed, removed.seq, NOW);
			removedSeq = first.read(NOW).seq;
		} finally {
			first.close();
			second.close();
		}
		const reopened = createSqliteBudgetAdmissionAuthority(options);
		try {
			expect(() => reopened.configure(snapshot(), removedSeq, NOW)).toThrow(
				"entitlement observation",
			);
			const depleted = snapshot();
			const bucket = depleted.entitlements[0];
			if (!bucket) throw new Error("fixture bucket missing");
			bucket.remainingUnits = 0;
			reopened.configure(depleted, removedSeq, NOW);
			const refreshed = snapshot();
			const refreshedBucket = refreshed.entitlements[0];
			if (!refreshedBucket) throw new Error("fixture bucket missing");
			refreshedBucket.observedAt = "2026-10-30T01:00:00Z";
			reopened.configure(refreshed, removedSeq + 1, NOW);
			expect(reopened.read(NOW).entitlements[0]?.remainingUnits).toBe(10);
		} finally {
			reopened.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		"2026-10-29T23:59:59Z",
		"2026-10-30T00:00:00Z",
		"2026-10-30T00:00:00+00:00",
	])("rejects removed bucket revival at stale or equivalent observation %s", (observedAt) => {
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		consume(authority);
		const removed = authority.read(NOW);
		removed.entitlements = [];
		authority.configure(removed, removed.seq, NOW);
		const revived = snapshot();
		const bucket = revived.entitlements[0];
		if (!bucket) throw new Error("fixture bucket missing");
		bucket.observedAt = observedAt;
		expect(() => authority.configure(revived, 3, NOW)).toThrow(
			"entitlement observation",
		);
	});

	it("allows a fresh bucket period while retaining the old bucket observation fence", () => {
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		consume(authority);
		const next = snapshot();
		const bucket = next.entitlements[0];
		if (!next.identity || !bucket) throw new Error("fixture identity missing");
		next.identity.periodId = "p2";
		bucket.periodId = "p2";
		authority.configure(next, 2, NOW);
		expect(authority.read(NOW).entitlements[0]?.remainingUnits).toBe(10);
		const oldBucket = authority.read(NOW);
		oldBucket.entitlements = snapshot().entitlements;
		expect(() => authority.configure(oldBucket, 3, NOW)).toThrow(
			"entitlement observation",
		);
	});

	it.each([
		"unit",
		"validUntil",
	] as const)("requires a fresh observation to change a removed bucket's %s", (field) => {
		const authority = createBudgetAdmissionAuthority({ snapshot: snapshot() });
		const removed = authority.read(NOW);
		removed.entitlements = [];
		authority.configure(removed, 0, NOW);
		const changed = snapshot();
		const bucket = changed.entitlements[0];
		if (!bucket) throw new Error("fixture bucket missing");
		bucket[field] = field === "unit" ? "runner-ms" : "2026-11-01T00:00:00Z";
		expect(() => authority.configure(changed, 1, NOW)).toThrow(
			"entitlement observation",
		);
		bucket.observedAt = "2026-10-30T01:00:00Z";
		authority.configure(changed, 1, NOW);
		expect(authority.read(NOW).entitlements[0]?.[field]).toBe(bucket[field]);
	});

	it("does not consume an observation when configuration persistence fails", () => {
		let refuse = false;
		const authority = createBudgetAdmissionAuthority({
			snapshot: snapshot(),
			commit() {
				if (refuse) throw new Error("durable write refused");
			},
		});
		const removed = authority.read(NOW);
		removed.entitlements = [];
		authority.configure(removed, 0, NOW);
		const refreshed = snapshot();
		const bucket = refreshed.entitlements[0];
		if (!bucket) throw new Error("fixture bucket missing");
		bucket.observedAt = "2026-10-30T01:00:00Z";
		bucket.remainingUnits = 20;
		refuse = true;
		expect(() => authority.configure(refreshed, 1, NOW)).toThrow(
			"write refused",
		);
		refuse = false;
		authority.configure(snapshot(), 1, NOW);
		expect(authority.read(NOW).entitlements[0]?.remainingUnits).toBe(10);
	});

	it("rejects journal entries that revive a period or removed bucket", () => {
		const journal: BudgetAuthorityEvent[] = [];
		const base = snapshot();
		const authority = createBudgetAdmissionAuthority({
			snapshot: base,
			commit: (event) => {
				journal.push(event);
			},
		});
		consume(authority);
		const removed = authority.read(NOW);
		removed.entitlements = [];
		authority.configure(removed, removed.seq, NOW);
		const removalEvent = journal.at(-1);
		if (!removalEvent?.snapshot) throw new Error("fixture event missing");
		const forged = clone(BudgetAuthorityEventSchema, removalEvent);
		if (!forged.snapshot) throw new Error("fixture snapshot missing");
		forged.snapshot.seq++;
		forged.snapshot.entitlements = snapshot().entitlements;
		expect(() =>
			createBudgetAdmissionAuthority({
				snapshot: base,
				priorEvents: [...journal, forged],
			}),
		).toThrow("entitlement observation");
		const p2 = authority.read(NOW);
		if (!p2.identity) throw new Error("fixture identity missing");
		p2.identity.periodId = "p2";
		authority.configure(p2, p2.seq, NOW);
		const resetEvent = journal.at(-1);
		if (!resetEvent) throw new Error("fixture reset missing");
		const revived = clone(BudgetAuthorityEventSchema, resetEvent);
		if (!revived.snapshot?.identity)
			throw new Error("fixture snapshot missing");
		revived.snapshot.seq++;
		revived.snapshot.identity.periodId = "p1";
		expect(() =>
			createBudgetAdmissionAuthority({
				snapshot: base,
				priorEvents: [...journal, revived],
			}),
		).toThrow("retired period");
	});

	it("keeps multi-unit bucket history independent through configuration and replay", () => {
		const base = multiUnitSnapshot();
		const journal: BudgetAuthorityEvent[] = [];
		const authority = createBudgetAdmissionAuthority({
			snapshot: base,
			commit: (event) => journal.push(event),
		});
		const removed = authority.read(NOW);
		removed.entitlements = [];
		authority.configure(removed, 0, NOW);
		const refreshed = multiUnitSnapshot();
		const runner = refreshed.entitlements.find(
			(row) => row.unit === "runner-ms",
		);
		if (!runner) throw new Error("runner fixture missing");
		runner.observedAt = "2026-10-30T01:00:00Z";
		refreshed.entitlements = [runner];
		authority.configure(refreshed, 1, NOW);
		const restored = authority.read(NOW);
		const request = multiUnitSnapshot().entitlements.find(
			(row) => row.unit === "request",
		);
		if (!request) throw new Error("request fixture missing");
		request.observedAt = "2026-10-30T02:00:00Z";
		restored.entitlements.push(request);
		authority.configure(restored, 2, NOW);
		expect(authority.read(NOW).entitlements).toMatchObject([
			{ unit: "runner-ms", remainingUnits: 20 },
			{ unit: "request", remainingUnits: 10 },
		]);
		const reopened = createBudgetAdmissionAuthority({
			snapshot: base,
			priorEvents: journal,
		});
		expect(reopened.read(NOW).entitlements).toMatchObject([
			{ unit: "runner-ms", remainingUnits: 20 },
			{ unit: "request", remainingUnits: 10 },
		]);
	});

	it("keeps new units independent in a multi-unit bucket", () => {
		const base = multiUnitSnapshot();
		const journal: BudgetAuthorityEvent[] = [];
		const authority = createBudgetAdmissionAuthority({
			snapshot: base,
			commit: (event) => journal.push(event),
		});
		const removed = authority.read(NOW);
		removed.entitlements = [];
		authority.configure(removed, 0, NOW);
		const added = authority.read(NOW);
		const request = multiUnitSnapshot().entitlements.find(
			(row) => row.unit === "request",
		);
		if (!request) throw new Error("request fixture missing");
		added.entitlements = [
			create(BudgetEntitlementSchema, {
				...request,
				unit: "scheduler-ms",
				remainingUnits: 30,
				observedAt: "2026-10-30T01:00:00Z",
			}),
		];
		authority.configure(added, 1, NOW);
		expect(authority.read(NOW).entitlements).toMatchObject([
			{ unit: "scheduler-ms", remainingUnits: 30 },
		]);
		const reopened = createBudgetAdmissionAuthority({
			snapshot: base,
			priorEvents: journal,
		});
		expect(reopened.read(NOW).entitlements).toMatchObject([
			{ unit: "scheduler-ms", remainingUnits: 30 },
		]);
	});

	it("uses the latest lineage observation after a unit migration returns to an earlier unit", () => {
		const base = snapshot();
		const journal: BudgetAuthorityEvent[] = [];
		const authority = createBudgetAdmissionAuthority({
			snapshot: base,
			commit: (event) => journal.push(event),
		});
		const removed = authority.read(NOW);
		removed.entitlements = [];
		authority.configure(removed, 0, NOW);
		const migrated = snapshot();
		const migratedBucket = migrated.entitlements[0];
		if (!migratedBucket) throw new Error("migrated bucket missing");
		migratedBucket.unit = "runner-ms";
		migratedBucket.remainingUnits = 20;
		migratedBucket.observedAt = "2026-10-30T01:00:00Z";
		authority.configure(migrated, 1, NOW);
		const removedAgain = authority.read(NOW);
		removedAgain.entitlements = [];
		authority.configure(removedAgain, 2, NOW);
		const restored = snapshot();
		expect(() => authority.configure(restored, 3, NOW)).toThrow(
			"entitlement observation",
		);
		const restoredBucket = restored.entitlements[0];
		if (!restoredBucket) throw new Error("restored bucket missing");
		restoredBucket.remainingUnits = 30;
		restoredBucket.observedAt = "2026-10-30T02:00:00Z";
		authority.configure(restored, 3, NOW);
		const reopened = createBudgetAdmissionAuthority({
			snapshot: base,
			priorEvents: journal,
		});
		expect(reopened.read(NOW).entitlements).toMatchObject([
			{ unit: "micros", remainingUnits: 30 },
		]);
	});

	it("keeps credit and allowance history independent", () => {
		const base = snapshot();
		const credit = base.entitlements[0];
		if (!credit) throw new Error("credit fixture missing");
		credit.bucketId = "shared";
		credit.observedAt = "2026-10-30T01:00:00Z";
		const authority = createBudgetAdmissionAuthority({ snapshot: base });
		const removed = authority.read(NOW);
		removed.entitlements = [];
		authority.configure(removed, 0, NOW);
		const allowance = snapshot();
		const allowanceBucket = allowance.entitlements[0];
		if (!allowanceBucket) throw new Error("allowance fixture missing");
		allowanceBucket.bucketId = "shared";
		allowanceBucket.kind = "allowance";
		authority.configure(allowance, 1, NOW);
		expect(authority.read(NOW).entitlements[0]?.kind).toBe("allowance");
		const staleCredit = snapshot();
		const staleCreditBucket = staleCredit.entitlements[0];
		if (!staleCreditBucket) throw new Error("stale credit fixture missing");
		staleCreditBucket.bucketId = "shared";
		expect(() => authority.configure(staleCredit, 2, NOW)).toThrow(
			"entitlement observation",
		);
	});

	it("rejects a kindless fresh memory seed but reopens a persisted base", () => {
		const legacy = snapshot();
		const entitlement = legacy.entitlements[0];
		if (!entitlement) throw new Error("legacy entitlement missing");
		entitlement.kind = "";
		expect(() => createBudgetAdmissionAuthority({ snapshot: legacy })).toThrow(
			"entitlement scope",
		);
		const reopened = createBudgetAdmissionAuthority({
			snapshot: legacy,
			priorEvents: [],
		});
		expect(reopened.read(NOW).entitlements[0]?.kind).toBe("allowance");
	});

	it("reopens a legacy SQLite snapshot with an implicit allowance kind", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-legacy-budget-kind-"));
		directories.push(directory);
		const path = join(directory, "budget.sqlite");
		const options = { path, snapshot: snapshot(), now: () => NOW };
		const initial = createSqliteBudgetAdmissionAuthority(options);
		initial.close();
		const database = new DatabaseSync(path);
		database
			.prepare(
				"UPDATE budget_base SET body=json_remove(body, '$.entitlements[0].kind') WHERE id=1",
			)
			.run();
		database.close();
		const legacySeed = snapshot();
		const legacyEntitlement = legacySeed.entitlements[0];
		if (!legacyEntitlement) throw new Error("legacy seed entitlement missing");
		legacyEntitlement.kind = "";
		const reopened = createSqliteBudgetAdmissionAuthority({
			path,
			snapshot: legacySeed,
			now: () => NOW,
		});
		try {
			expect(reopened.read(NOW).entitlements[0]?.kind).toBe("allowance");
			const invalidWrite = reopened.read(NOW);
			const entitlement = invalidWrite.entitlements[0];
			if (!entitlement) throw new Error("legacy entitlement missing");
			entitlement.kind = "";
			expect(() => reopened.configure(invalidWrite, 0, NOW)).toThrow(
				"entitlement scope",
			);
		} finally {
			reopened.close();
		}
		const fresh = snapshot();
		const entitlement = fresh.entitlements[0];
		if (!entitlement) throw new Error("fresh entitlement missing");
		entitlement.kind = "";
		expect(() =>
			createSqliteBudgetAdmissionAuthority({
				path: join(directory, "fresh.sqlite"),
				snapshot: fresh,
				now: () => NOW,
			}),
		).toThrow("entitlement scope");
	});

	it("does not retire a period when its durable commit fails", () => {
		let refuse = true;
		const authority = createBudgetAdmissionAuthority({
			snapshot: snapshot(),
			commit() {
				if (refuse) throw new Error("durable write refused");
			},
		});
		const p2 = snapshot();
		if (!p2.identity) throw new Error("fixture identity missing");
		p2.identity.periodId = "p2";
		expect(() => authority.configure(p2, 0, NOW)).toThrow("write refused");
		refuse = false;
		authority.configure(snapshot(), 0, NOW);
		expect(authority.read(NOW).identity?.periodId).toBe("p1");
		authority.configure(p2, 1, NOW);
		expect(() => authority.configure(snapshot(), 2, NOW)).toThrow(
			"retired period",
		);
	});
});
