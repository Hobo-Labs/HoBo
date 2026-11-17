import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	clone,
	create,
	fromBinary,
	toBinary,
	toJsonString,
} from "@bufbuild/protobuf";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
	BudgetLedgerSnapshotSchema,
	buildDeploymentRequestFromParts,
	contentHashOf,
	createLocalHostCatalog,
	createSqliteBudgetAdmissionAuthority,
	EntitlementClaimSchema,
	HostingPolicyProofSchema,
	HostingQuoteSchema,
	LOCAL_HOST_PROVIDER_ID,
	localYardInstance,
	ProviderAccountExposureSchema,
	resolveBindleDeployment,
	YARD_EVENTS,
	yardEvent,
} from "../src/index.js";

const independentDigest = (quote: ReturnType<typeof makeQuote>) =>
	createHash("sha256")
		.update(toJsonString(HostingQuoteSchema, quote))
		.digest("hex");

function makeQuote(requestDigest: string, total = 10) {
	return create(HostingQuoteSchema, {
		quoteId: "reused-quote-id",
		yardId: "yard:a",
		providerId: LOCAL_HOST_PROVIDER_ID,
		ownerTenantId: "tenant",
		currency: "USD",
		totalMicros: total,
		liabilityBoundMicros: total + 50,
		components: [{ name: "execution", costMicros: total }],
		requestDigest,
		observedAt: "2026-10-29T00:00:00Z",
		validUntil: "2026-11-01T00:00:00Z",
	});
}

const changes = [
	"liability",
	"total",
	"component",
	"yard",
	"provider",
	"owner",
	"expiry",
	"account",
	"entitlement",
	"plan",
	"request",
] as const;
type Change = (typeof changes)[number];

async function evaluate(
	mode: "missing" | "stale" | "foreign" | "wrong-id" | "matching",
	change: Change = "liability",
	total = 10,
) {
	const now = "2026-10-29T12:00:00Z";
	const dir = mkdtempSync(join(tmpdir(), "yard-policy-quote-"));
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
		const quote = makeQuote(contentHashOf(request), total);
		const old = clone(HostingQuoteSchema, quote);
		switch (change) {
			case "liability":
				old.liabilityBoundMicros = total + 49;
				break;
			case "total":
				old.totalMicros = total + 1;
				old.components[0].costMicros = total + 1;
				break;
			case "component":
				old.components[0].name = "egress";
				break;
			case "yard":
				old.yardId = "yard:b";
				break;
			case "provider":
				old.providerId = "other";
				break;
			case "owner":
				old.ownerTenantId = "other";
				break;
			case "expiry":
				old.validUntil = "2026-11-02T00:00:00Z";
				break;
			case "account":
				old.providerAccounts = [
					create(ProviderAccountExposureSchema, {
						providerAccountId: "account",
						liabilityMicros: 1,
					}),
				];
				break;
			case "entitlement":
				old.entitlementClaims = [
					create(EntitlementClaimSchema, {
						bucketId: "bucket",
						unit: "seconds",
						units: 1,
					}),
				];
				break;
			case "plan":
				old.financialPlanHash = "prior-plan";
				break;
			case "request":
				old.requestDigest = "other-request";
				break;
		}
		const expected = independentDigest(quote);
		const supplied =
			mode === "missing"
				? ""
				: mode === "stale"
					? independentDigest(old)
					: mode === "foreign"
						? "0".repeat(64)
						: expected;
		let presentedDigest: string | undefined;
		const result = await resolveBindleDeployment(request, {
			brokerId: "broker:test",
			ownerTenantId: "tenant",
			catalog: createLocalHostCatalog(),
			seedLocalYard: false,
			priorEvents: [
				yardEvent(YARD_EVENTS.Registered, { yard }),
				yardEvent(YARD_EVENTS.Ready, { yardId: yard.yardId }),
			],
			hostingBudget: { authority, quotes: [quote], now: () => now },
			authorizeHosting(input) {
				presentedDigest = input.quoteDigest;
				return {
					gate: { effect: "allow", reasons: [], events: [] },
					proof: create(HostingPolicyProofSchema, {
						requestDigest: input.requestDigest,
						quoteId: mode === "wrong-id" ? "other-id" : input.quote.quoteId,
						quoteDigest: supplied,
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
			expected,
			presentedDigest,
			reserved: authority.read(now).reservedMicros,
		};
	} finally {
		authority.close();
		rmSync(dir, { recursive: true, force: true });
	}
}

it.each([
	"missing",
	"stale",
	"foreign",
	"wrong-id",
	"matching",
] as const)("binds funded policy proof to complete quote content: %s", async (mode) => {
	const { result, expected, presentedDigest, reserved } = await evaluate(mode);
	expect(presentedDigest).toBe(expected);
	if (mode === "matching") {
		expect(result.outcome).toBe("resolved");
		expect(reserved).toBe(60);
		expect(result.receipt?.hostingPolicyProof?.quoteDigest).toBe(expected);
		expect(result.receipt?.budgetReservation?.quoteDigest).toBe(expected);
	} else {
		expect(result.outcome).toBe("rejected");
		expect(result.receipt).toBeUndefined();
		expect(reserved).toBe(0);
	}
});

it("preserves the quote digest on the wire and decodes legacy proofs without one", () => {
	const legacy = create(HostingPolicyProofSchema, { quoteId: "q" });
	expect(
		fromBinary(
			HostingPolicyProofSchema,
			toBinary(HostingPolicyProofSchema, legacy),
		).quoteDigest,
	).toBe("");
	const bound = create(HostingPolicyProofSchema, {
		quoteId: "q",
		quoteDigest: "a".repeat(64),
	});
	expect(
		fromBinary(
			HostingPolicyProofSchema,
			toBinary(HostingPolicyProofSchema, bound),
		).quoteDigest,
	).toBe("a".repeat(64));
});

it("rejects different same-ID quote contents across generated approvals", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.constantFrom(...changes),
			fc.integer({ min: 1, max: 40 }),
			fc.boolean(),
			async (change, total, matching) => {
				const { result, expected, presentedDigest, reserved } = await evaluate(
					matching ? "matching" : "stale",
					change,
					total,
				);
				expect(presentedDigest).toBe(expected);
				expect(result.outcome).toBe(matching ? "resolved" : "rejected");
				expect(reserved).toBe(matching ? total + 50 : 0);
			},
		),
		{ seed: 614526, numRuns: 100 },
	);
});
