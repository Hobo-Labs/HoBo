import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	HostingQuoteSchema,
} from "../src/budget-authority.js";
import { createSqliteBudgetAdmissionAuthority } from "../src/budget-sqlite.js";

const NOW = "2026-10-30T12:00:00Z";

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
	});
}

function quote() {
	return create(HostingQuoteSchema, {
		quoteId: "quote",
		yardId: "yard",
		providerId: "provider",
		ownerTenantId: "tenant",
		currency: "USD",
		totalMicros: 40,
		liabilityBoundMicros: 60,
		observedAt: "2026-10-30T00:00:00Z",
		validUntil: "2026-10-31T00:00:00Z",
		components: [{ name: "usage", costMicros: 40 }],
		requestDigest: "request",
	});
}

it("atomically retains a financial hold when execution claims after an unused lookup", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-budget-execution-fence-"));
	const base = snapshot();
	const options = {
		path: join(directory, "budget.sqlite"),
		snapshot: base,
		now: () => NOW,
	};
	const first = createSqliteBudgetAdmissionAuthority(options);
	const second = createSqliteBudgetAdmissionAuthority(options);
	try {
		const q = quote();
		if (!base.identity) throw new Error("fixture identity missing");
		first.reserve({
			reservationId: "work",
			requestDigest: q.requestDigest,
			quote: q,
			identity: base.identity,
			expectedSeq: 0,
			now: NOW,
		});
		expect(first.lookup("work")?.executionDigest).toBe("");
		second.claimExecution({
			reservationId: "work",
			requestDigest: q.requestDigest,
			executionDigest: "execution",
		});
		expect(() => first.release("work", true, "cancelled-before-claim")).toThrow(
			"execution-claimed",
		);
		expect(second.read(NOW)).toMatchObject({ seq: 2, reservedMicros: 60 });
		expect(second.lookup("work")).toMatchObject({
			status: "held",
			executionDigest: "execution",
		});
		const reopened = createSqliteBudgetAdmissionAuthority(options);
		try {
			expect(() => reopened.release("work", true, "unused")).toThrow(
				"execution-claimed",
			);
			reopened.settle("work", 0, {
				usageEvidenceRef: "authoritative-final-zero-usage",
				sourceStoppedEvidenceRef: "provider-confirms-stopped",
			});
			expect(first.read(NOW).reservedMicros).toBe(0);
			expect(first.lookup("work")?.status).toBe("settled");
		} finally {
			reopened.close();
		}
	} finally {
		first.close();
		second.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("fences first claim and claimed replay against independent SQLite exposure changes", () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-budget-claim-sequence-"));
	const base = snapshot();
	const options = {
		path: join(directory, "budget.sqlite"),
		snapshot: base,
		now: () => NOW,
	};
	const first = createSqliteBudgetAdmissionAuthority(options);
	const second = createSqliteBudgetAdmissionAuthority(options);
	try {
		if (!base.identity) throw new Error("fixture identity missing");
		first.reserve({
			reservationId: "work",
			requestDigest: "request",
			quote: quote(),
			identity: base.identity,
			expectedSeq: 0,
			now: NOW,
		});
		const approvedSeq = first.read(NOW).seq;
		const otherQuote = quote();
		otherQuote.totalMicros = 20;
		otherQuote.liabilityBoundMicros = 20;
		otherQuote.components = [{ ...otherQuote.components[0], costMicros: 20 }];
		second.reserve({
			reservationId: "other",
			requestDigest: "request",
			quote: otherQuote,
			identity: base.identity,
			expectedSeq: approvedSeq,
			now: NOW,
		});
		const claim = {
			reservationId: "work",
			requestDigest: "request",
			executionDigest: "execution",
		};
		expect(() =>
			first.claimExecution({ ...claim, expectedSeq: approvedSeq }),
		).toThrow("budget sequence conflict");
		expect(first.lookup("work")?.executionDigest).toBe("");
		const freshSeq = first.read(NOW).seq;
		first.claimExecution({ ...claim, expectedSeq: freshSeq });
		const claimedSeq = first.read(NOW).seq;
		expect(() =>
			first.claimExecution({ ...claim, expectedSeq: freshSeq }),
		).toThrow("budget sequence conflict");
		expect(
			first.claimExecution({ ...claim, expectedSeq: claimedSeq })
				.executionDigest,
		).toBe("execution");
		expect(first.read(NOW).seq).toBe(claimedSeq);
		second.settle("other", 120, {
			usageEvidenceRef: "final-overrun",
			sourceStoppedEvidenceRef: "stopped",
		});
		expect(() =>
			first.claimExecution({ ...claim, expectedSeq: claimedSeq }),
		).toThrow("budget sequence conflict");
		expect(first.lookup("work")?.status).toBe("held");
		expect(first.claimExecution(claim).executionDigest).toBe("execution");
	} finally {
		first.close();
		second.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
