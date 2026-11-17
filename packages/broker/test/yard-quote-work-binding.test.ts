import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	buildDeploymentRequestFromParts,
	contentHashOf,
	createLocalHostCatalog,
	createSqliteBudgetAdmissionAuthority,
	HostingPolicyProofSchema,
	HostingQuoteSchema,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	prepareYardHostingWork,
	resolveBindleDeployment,
	YARD_EVENTS,
	yardEvent,
} from "../src/index.js";

const modes = [
	"missing",
	"definition",
	"price",
	"catalog",
	"request",
	"broker",
	"yard",
	"matching",
] as const;
type Mode = (typeof modes)[number];

async function evaluate(mode: Mode) {
	const now = "2026-10-29T12:00:00Z";
	const dir = mkdtempSync(join(tmpdir(), "yard-work-quote-"));
	const authority = createSqliteBudgetAdmissionAuthority({
		path: join(dir, "budget.sqlite"),
		now: () => now,
		snapshot: create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "2026-10",
				policyRevision: "r1",
			},
			limitMicros: 100,
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		}),
	});
	try {
		const request = buildDeploymentRequestFromParts({
			bindleName: "shop",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
			resources: [
				{ resourceId: "api", port: "hobo:http-service", features: [] },
			],
		});
		const yard = localYardInstance({
			yardId: "yard:a",
			ownerTenantId: "tenant",
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		const catalog = createLocalHostCatalog("test-machine");
		const previousCatalog = {
			catalogHash:
				mode === "catalog" ? "sha256:older-catalog" : catalog.catalogHash,
			definitions: () =>
				catalog.definitions().map((d) => ({
					...d,
					id: mode === "definition" ? `old:${d.id}` : d.id,
					cost: {
						...d.cost,
						marginalPrice: mode === "price" ? "1.00" : d.cost.marginalPrice,
					},
				})),
		};
		const plan = prepareYardHostingWork({
			request:
				mode === "request"
					? { ...request, requestId: "other-request" }
					: request,
			brokerId: mode === "broker" ? "other-broker" : "broker:test",
			ownerTenantId: "tenant",
			catalog: previousCatalog,
			yardId: mode === "yard" ? "yard:other" : yard.yardId,
			providerId: LOCAL_HOST_PROVIDER_ID,
		});
		if ("error" in plan) throw new Error(plan.error);
		const quote = create(HostingQuoteSchema, {
			quoteId: "quote",
			yardId: yard.yardId,
			providerId: LOCAL_HOST_PROVIDER_ID,
			ownerTenantId: "tenant",
			currency: "USD",
			totalMicros: 10,
			liabilityBoundMicros: 60,
			components: [{ name: "execution", costMicros: 10 }],
			requestDigest: contentHashOf(request),
			workDigest: mode === "missing" ? "" : plan.workDigest,
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		});
		let presentedWork: string | undefined;
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			ownerTenantId: "tenant",
			catalog,
			seedLocalYard: false,
			priorEvents: [
				yardEvent(YARD_EVENTS.Registered, { yard }),
				yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
			],
			hostingBudget: { authority, quotes: [quote], now: () => now },
			authorizeHosting(input) {
				presentedWork = input.workDigest;
				expect(input.placements).toEqual(plan.placements);
				expect(Object.isFrozen(input.placements)).toBe(true);
				return {
					gate: { effect: "allow", reasons: [], events: [] },
					proof: create(HostingPolicyProofSchema, {
						requestDigest: input.requestDigest,
						quoteId: input.quote.quoteId,
						quoteDigest: input.quoteDigest,
						identity: input.identity,
						effect: "allow",
						policyHash: "approved",
						evidenceRef: "policy",
						obligationsSatisfied: true,
					}),
				};
			},
		});
		return {
			result,
			expected: plan.workDigest,
			presentedWork,
			reserved: authority.read(now).reservedMicros,
		};
	} finally {
		authority.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

it.each(modes)("binds a Yard quote to selected work: %s", async (mode) => {
	const { result, expected, presentedWork, reserved } = await evaluate(mode);
	if (mode === "matching") {
		expect(result.outcome).toBe("resolved");
		expect(presentedWork).toBe(expected);
		expect(result.receipt?.hostingQuote?.workDigest).toBe(expected);
		expect(reserved).toBe(60);
	} else {
		expect(result.outcome).toBe("rejected");
		expect(presentedWork).toBeUndefined();
		expect(reserved).toBe(0);
	}
});

it("refuses stale work bindings across generated quote inputs", async () => {
	await fc.assert(
		fc.asyncProperty(fc.constantFrom(...modes), async (mode) => {
			const { result, reserved } = await evaluate(mode);
			expect(result.outcome).toBe(
				mode === "matching" ? "resolved" : "rejected",
			);
			expect(reserved).toBe(mode === "matching" ? 60 : 0);
		}),
		{ seed: 614527, numRuns: 80 },
	);
});

it("round-trips a work-bound quote and recognizes legacy quotes without a binding", () => {
	const legacy = create(HostingQuoteSchema, { quoteId: "q" });
	expect(
		fromBinary(HostingQuoteSchema, toBinary(HostingQuoteSchema, legacy))
			.workDigest,
	).toBe("");
	const bound = create(HostingQuoteSchema, {
		quoteId: "q",
		workDigest: `sha256:${"a".repeat(64)}`,
	});
	expect(
		fromBinary(HostingQuoteSchema, toBinary(HostingQuoteSchema, bound))
			.workDigest,
	).toBe(`sha256:${"a".repeat(64)}`);
});
