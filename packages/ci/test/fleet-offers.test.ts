import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
	AccountSchema,
	LeaseSchema,
	OfferSchema,
} from "../src/_generated/ci_pb.js";
import {
	balanceFleet,
	fleetAccountExposure,
	fleetBudgetPolicy,
	fleetMembersFromAccount,
	fleetRoleOfOffer,
	modelledOfferTerms,
	RUNNER_FINANCIAL_MODELS,
	runnerFinancialModel,
	runnerModelForOffer,
} from "../src/fleet/index.js";

const NOW = "2026-11-10T00:00:00Z";

function offer(
	id: string,
	provider: string,
	runsOn: string,
	fields: Partial<Parameters<typeof create<typeof OfferSchema>>[1]> = {},
) {
	return create(OfferSchema, {
		id,
		provider,
		providerAccountId: `${provider}-account`,
		enabled: true,
		runsOn,
		budgetMicros: 10_000_000,
		concurrency: 3,
		observedAt: "2026-11-09T00:00:00Z",
		validUntil: "2026-12-09T00:00:00Z",
		sourceUrl: "https://example.test/rates",
		bridgeAcknowledged: true,
		...fields,
	});
}

function account(routingStrategy = "") {
	return create(AccountSchema, {
		id: "hobo-labs",
		budgetMicros: 5_000_000,
		maxRuntimeMinutes: 9,
		startupMinutes: 1,
		routingStrategy,
		offers: [
			offer("box", "hobo-box-worker", "hobo-isolated-worker", {
				backend: "isolated-container",
				budgetMicros: 0,
			}),
			offer("arc", "kubernetes", "hobo-arc", { backend: "gh-actions" }),
			offer("blacksmith", "blacksmith", "blacksmith-4vcpu-ubuntu-2404", {
				freeMinutes: 1500,
				priceMicrosPerMinute: 8000,
			}),
			offer("github", "github", "ubuntu-24.04"),
			offer("sandbox", "vercel", "sandbox", { backend: "sandbox" }),
		],
	});
}

function lease(
	offerId: string,
	state: string,
	fields: Partial<Parameters<typeof create<typeof LeaseSchema>>[1]> = {},
) {
	return create(LeaseSchema, {
		accountId: "hobo-labs",
		offerId,
		state,
		...fields,
	});
}

describe("fleet offers", () => {
	it("reads an offer's tier from its provider's model", () => {
		const [box, arc, blacksmith, github, sandbox] = account().offers;
		if (!box || !arc || !blacksmith || !github || !sandbox)
			throw new Error("fixture");
		expect(fleetRoleOfOffer(box)).toBe("primary");
		expect(fleetRoleOfOffer(arc)).toBe("overflow");
		expect(fleetRoleOfOffer(blacksmith)).toBe("overflow");
		expect(fleetRoleOfOffer(github)).toBe("last-resort");
		// No model prices a Sandbox as a runner host.
		expect(fleetRoleOfOffer(sandbox)).toBeUndefined();
		expect(runnerModelForOffer(blacksmith)?.id).toBe("blacksmith-4vcpu");
	});

	it("turns a model into the rate an operator would observe for an offer", () => {
		const blacksmith = runnerFinancialModel("blacksmith-4vcpu");
		const agent37 = runnerFinancialModel("agent37-vm-4vcpu");
		if (!blacksmith || !agent37) throw new Error("fixture");
		expect(modelledOfferTerms(blacksmith)).toMatchObject({
			priceMicrosPerMinute: 8000,
			freeMinutes: 1500,
			sourceUrl: "https://www.blacksmith.sh/pricing",
		});
		expect(modelledOfferTerms(agent37)).toMatchObject({
			priceMicrosPerMinute: 522,
			freeMinutes: 0,
			concurrency: 3,
		});
		for (const model of RUNNER_FINANCIAL_MODELS)
			expect(
				Number.isSafeInteger(modelledOfferTerms(model).priceMicrosPerMinute),
				model.id,
			).toBe(true);
	});

	it("builds one member per priced offer from the account's own facts", () => {
		const leases = [
			lease("box", "running"),
			lease("box", "reserved"),
			lease("blacksmith", "running", {
				reservedFreeMinutes: 10,
				reservedPaidMicros: 0,
			}),
			lease("blacksmith", "completed", {
				billedFreeMinutes: 90,
				paidMicros: 40_000,
			}),
			lease("box", "expired"),
		];
		const members = fleetMembersFromAccount(account(), leases, {
			poolLabel: "hobo",
		});
		expect(members.map((member) => member.model.id)).toEqual([
			"box",
			"arc",
			"blacksmith",
			"github",
		]);
		const [box, , blacksmith] = members;
		expect(box).toMatchObject({
			activeJobs: 2,
			concurrency: 3,
			model: { binding: "inject", runsOn: "hobo", usdPerMinute: "0.000000" },
		});
		expect(blacksmith).toMatchObject({
			activeJobs: 1,
			payer: "blacksmith-account",
			payerExposureMicros: 40_000,
			commercial: { subscribed: true, allowanceRemainingMinutes: "1400" },
			model: {
				binding: "label",
				runsOn: "blacksmith-4vcpu-ubuntu-2404",
				usdPerMinute: "0.008000",
				monthlyFreeMinutes: "1500",
			},
		});
	});

	it("gives an account without an authored policy its legacy ceiling as the policy", () => {
		const legacy = fleetBudgetPolicy(account("maximize-credits"));
		expect(legacy).toMatchObject({
			tenantId: "hobo-labs",
			limitMicros: 5_000_000,
			objective: "maximize-credits",
			constraints: [],
		});
		const authored = create(AccountSchema, {
			...account(),
			budgetPolicy: {
				schemaVersion: "hobo.budget-policy/v1",
				tenantId: "hobo-labs",
				budgetId: "engineering",
				periodId: "2026-11",
				revision: "r7",
				workloads: ["ci"],
				currency: "USD",
				limitMicros: 9_000_000,
				objective: "min-cost",
				enforcement: "conservative",
				periodKind: "manual",
				constraints: [],
			},
		});
		expect(fleetBudgetPolicy(authored)).toMatchObject({
			budgetId: "engineering",
			revision: "r7",
			limitMicros: 9_000_000,
		});
	});

	it("balances the account's real offers: box, then ARC, then rented, then GitHub", () => {
		const spill = (boxJobs: number, arcJobs: number) => {
			const leases = [
				...Array.from({ length: boxJobs }, () => lease("box", "running")),
				...Array.from({ length: arcJobs }, () => lease("arc", "running")),
			];
			const current = account();
			return balanceFleet({
				members: fleetMembersFromAccount(current, leases, {
					poolLabel: "hobo",
				}),
				demand: {
					id: "Hobo-Labs/HoBo:1:2:1",
					minutes: 10,
					repository: { visibility: "public", ownerType: "organization" },
					forkPullRequest: false,
					needsDocker: true,
				},
				policy: fleetBudgetPolicy(current),
				...fleetAccountExposure(current, leases),
				now: NOW,
				allowNewProviderAgreements: false,
			}).ranking.map((choice) => choice.memberId);
		};
		expect(spill(0, 0)).toEqual(["box", "arc", "blacksmith", "github"]);
		expect(spill(3, 0)).toEqual(["arc", "blacksmith", "github"]);
		expect(spill(3, 3)).toEqual(["blacksmith", "github"]);
	});

	it("counts held and settled money as exposure", () => {
		expect(
			fleetAccountExposure(account(), [
				lease("blacksmith", "running", { reservedPaidMicros: 80_000 }),
				lease("blacksmith", "completed", { paidMicros: 40_000 }),
				lease("blacksmith", "expired", { reservedPaidMicros: 999 }),
			]),
		).toEqual({ exposureMicros: 120_000, activeWork: 1 });
	});
});
