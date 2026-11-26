import { create } from "@bufbuild/protobuf";
import { ResourceLifecycleObservationRecordSchema } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { aggregateHostingBillingObservations } from "../src/hosting-billing-observations.js";

function record(
	resourceId: string,
	settledMicros: number,
	providerAccountId = "account",
) {
	return create(ResourceLifecycleObservationRecordSchema, {
		tenantId: "tenant",
		operationId: "settle",
		providerId: "native",
		providerAccountId,
		productId: "service/v1",
		resourceId,
		physicalId: `native-${resourceId}`,
		status: "unknown",
		observedAtMs: 1000,
		evidenceRef: `native:${resourceId}`,
		usageFinal: true,
		settledMicros,
		usageEvidenceRef: `invoice:line-${resourceId}`,
	});
}
function aggregate(records: ReturnType<typeof record>[], payers = ["account"]) {
	return aggregateHostingBillingObservations({
		tenantId: "tenant",
		operationId: "settle",
		providerAccountIds: new Set(payers),
		records,
		requiredResources: records,
		nowMs: 1000,
		maxAgeMs: 100,
	});
}
describe("complete multi-resource hosting billing", () => {
	it("keeps the hold when a signed reader omits a live database in the same payer's actual frozen inventory", () => {
		const app = record("app", 7),
			database = record("database", 11);
		const result = aggregateHostingBillingObservations({
			tenantId: "tenant",
			operationId: "settle",
			providerAccountIds: new Set(["account"]),
			records: [app],
			requiredResources: [app, database],
			nowMs: 1000,
			maxAgeMs: 100,
		});
		expect(result.usageFinal).toBe(false);
	});
	it("sums multiple distinct resource charges in the same provider account", () => {
		const result = aggregate([record("app", 7), record("database", 11)]);
		expect(result.usageFinal).toBe(true);
		expect(result.settledMicros).toBe(18);
		expect(result.providerAccountTotals.get("account")).toBe(18);
	});
	it("does not double count a repeated native resource or accept a foreign payer", () => {
		const app = record("app", 7);
		expect(() =>
			aggregate([app, { ...app, usageEvidenceRef: "different-invoice" }]),
		).toThrow("repeats");
		expect(() => aggregate([record("app", 7, "foreign")])).toThrow(
			"foreign payer",
		);
	});
	it("retains finality while any payer or resource usage remains unresolved", () => {
		expect(aggregate([record("app", 7)], ["account", "other"]).usageFinal).toBe(
			false,
		);
		expect(
			aggregate([
				record("app", 7),
				{ ...record("database", 11), usageFinal: false },
			]).usageFinal,
		).toBe(false);
	});
	it("rejects foreign operation evidence, unsafe integer overflow and stale final invoices", () => {
		expect(() =>
			aggregate([{ ...record("app", 7), operationId: "other" }]),
		).toThrow();
		expect(() =>
			aggregate([
				record("app", Number.MAX_SAFE_INTEGER),
				record("database", 1),
			]),
		).toThrow("overflow");
		expect(() =>
			aggregate([{ ...record("app", 7), observedAtMs: 1 }]),
		).toThrow();
	});
});
