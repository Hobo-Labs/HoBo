import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
} from "../src/index.js";

const snapshot = create(BudgetLedgerSnapshotSchema, {
	identity: {
		tenantId: "tenant",
		budgetId: "budget",
		periodId: "period",
		policyRevision: "r1",
	},
	limitMicros: 100,
	observedAt: "2026-01-01T00:00:00Z",
	validUntil: "2027-01-01T00:00:00Z",
});

describe("durable SQLite budget authority", () => {
	it.each([
		":memory:",
		"file::memory:?cache=shared",
		"file:budget-memory?mode=memory&cache=shared",
		"",
	])("rejects memory-backed path %j", (path) => {
		expect(() => {
			const authority = createSqliteBudgetAdmissionAuthority({
				path,
				snapshot,
			});
			authority.close();
		}).toThrow();
	});
});
