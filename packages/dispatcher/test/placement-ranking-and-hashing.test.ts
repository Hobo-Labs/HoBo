/**
 * Placement ranking, credit-fact derivation, hysteresis and the canonical
 * hashing helpers (ADR-0071).
 *
 * The dispatcher's central claim is that a decision is a *pure function* of
 * (registry, `CreditLedgerView@seq`, request) — identical inputs replay to a
 * byte-identical `dispatch.Decided` fact. Two things can break that quietly:
 *
 * - **A non-total ordering.** The rank vector ends in the provider id and the
 *   definition id precisely so that no two candidates can compare equal. If a
 *   tie were ever left to `Array.prototype.sort`, the winner would depend on
 *   the engine's sort stability and the input order, and two replays of the
 *   same inputs could select different providers.
 * - **A non-canonical hash.** `canonicalJson` sorts keys at every depth, so two
 *   objects that differ only in key order hash the same. Without that, a
 *   ledger snapshot re-serialized by a different service would produce a
 *   different `balanceHash` and every replay check would fail spuriously.
 *
 * The credit-fact classification matters for a different reason: an account
 * with an unusable number must be treated as *unusable*, not as free. Reading
 * a NaN headroom as available capacity would route paid work to a provider
 * that will bill for it.
 */
import { describe, expect, it } from "vitest";

import {
	canonicalJson,
	createDispatcherRegistry,
	decideDispatch,
	decidePlacement,
	stableHash,
} from "../src/dispatcher.js";
import type { JsonValue } from "../src/json.js";

const DIGEST =
	"sha256:1111111111111111111111111111111111111111111111111111111111111111";

function ledgerView(accounts: unknown[] = []) {
	return {
		view: "CreditLedgerView",
		seq: 91,
		digest: DIGEST,
		asOf: "2026-06-27T00:00:00.000Z",
		accounts,
	};
}

function account(
	providerId: string,
	overrides: Record<string, JsonValue> = {},
) {
	return {
		providerId,
		dimension: "object-store.gib-month",
		currency: "USD",
		listUnitCost: 0.02,
		freeHeadroom: 0,
		rateHeadroom: 1000,
		concurrencyHeadroom: 10,
		...overrides,
	};
}

function candidate(
	definitionId: string,
	overrides: Record<string, JsonValue> = {},
) {
	return {
		definitionId,
		providerId: definitionId,
		registered: true,
		resourceType: "object-store",
		dimension: "object-store.gib-month",
		listUnitCost: 0.02,
		specificity: 1,
		priority: 0,
		region: "us-east-1",
		switchingCost: 0,
		...overrides,
	};
}

function placement(overrides: Record<string, JsonValue> = {}) {
	return decidePlacement({
		objective: "maximize-credits",
		resourceId: "bucket-1",
		resourceType: "object-store",
		units: 10,
		candidates: [candidate("a")],
		ledgerView: ledgerView([account("a")]),
		...overrides,
	});
}

function runnerAccount(
	providerId: string,
	overrides: Record<string, JsonValue> = {},
) {
	return account(providerId, { dimension: "runner.minutes", ...overrides });
}

/**
 * Credit facts are only projected onto the *dispatch* ranking —
 * `publicPlacementRanking` deliberately narrows to the placement-relevant
 * fields (definition, region, specificity, priority, score, rank). So every
 * credit-derivation assertion below goes through `decideDispatch`, which is
 * the surface that actually exposes `creditFacts`, `freeUnits`,
 * `budgetExceeded` and `nextCreditExpiresAt`.
 */
function dispatch(overrides: Record<string, JsonValue> = {}) {
	return decideDispatch({
		registry: createDispatcherRegistry([
			{
				id: "a",
				providerId: "a",
				category: "runner",
				registered: true,
				dimension: "runner.minutes",
				listUnitCost: 0.02,
				switchingCost: 0,
			},
		]),
		category: "runner",
		dispatchId: "d-1",
		objective: "maximize-credits",
		units: 10,
		ledgerView: ledgerView([runnerAccount("a")]),
		...overrides,
	});
}

describe("decidePlacement candidate filtering", () => {
	it("rejects an unregistered candidate with a stated reason", () => {
		// Rejections are reported, not dropped. An operator asking "why did my
		// cheaper provider not win?" needs the answer in the decision itself,
		// not in a log line somewhere else.
		const result = placement({
			candidates: [candidate("a"), candidate("b", { registered: false })],
		});
		expect(result.ok).toBe(true);
		expect(result.rejectedCandidates).toEqual([
			{ definitionId: "b", reason: "candidate is not registered" },
		]);
	});

	it("rejects a candidate whose resourceType does not match the request", () => {
		// The reason names both types, because the mismatch is usually a typo in
		// one of them and the reader needs to see which.
		const result = placement({
			candidates: [candidate("a"), candidate("b", { resourceType: "queue" })],
		});
		expect(result.rejectedCandidates[0]?.reason).toBe(
			"resourceType queue does not match object-store",
		);
	});

	it("treats a candidate as registered unless it says otherwise", () => {
		// `registered !== false`, so an absent flag means registered. A truthiness
		// check would silently exclude every candidate that omitted the field.
		const result = placement({
			candidates: [candidate("a", { registered: undefined })],
		});
		expect(result.ok).toBe(true);
		expect(result.winner).toBe("a");
	});

	it("fails with a stated reason when every candidate was rejected", () => {
		const result = placement({
			candidates: [candidate("a", { registered: false })],
		});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe(
			"no registered object-store placement candidates",
		);
		// The rejections survive onto the failure, so the failure explains itself.
		expect(result.rejectedCandidates).toHaveLength(1);
		expect(result.ranking).toEqual([]);
	});

	it("fails when there were no candidates at all", () => {
		const result = placement({ candidates: [] });
		expect(result.ok).toBe(false);
		expect(result.rejectedCandidates).toEqual([]);
	});

	it("treats an absent candidates list as empty rather than throwing", () => {
		expect(placement({ candidates: undefined }).ok).toBe(false);
	});
});

describe("decidePlacement request parsing", () => {
	it("defaults the objective and the unit count", () => {
		const result = decidePlacement({
			resourceId: "bucket-1",
			resourceType: "object-store",
			candidates: [candidate("a")],
			ledgerView: ledgerView([account("a")]),
		});
		expect(result.objective).toBe("maximize-credits");
		expect(result.ok).toBe(true);
	});

	it("refuses an unsupported objective", () => {
		// Only one objective exists today. Accepting an unknown one would rank by
		// credits while telling the caller it optimised for something else.
		expect(() => placement({ objective: "minimize-latency" })).toThrow(
			/objective must be maximize-credits/u,
		);
	});

	it("refuses a missing resource id or type", () => {
		expect(() => placement({ resourceId: "" })).toThrow(
			/resourceId must be a non-empty string/u,
		);
		expect(() => placement({ resourceType: undefined })).toThrow(
			/resourceType must be a non-empty string/u,
		);
	});

	it("refuses a non-positive unit count", () => {
		// Units divide into the effective marginal cost, so zero would produce an
		// Infinity score that sorts unpredictably against real costs.
		for (const units of [0, -1, Number.NaN]) {
			expect(() => placement({ units })).toThrow(
				/units must be greater than 0/u,
			);
		}
	});

	it("refuses a malformed request object", () => {
		expect(() => decidePlacement(null)).toThrow(/request must be an object/u);
		expect(() => decidePlacement([])).toThrow(/request must be an object/u);
	});

	it("refuses a candidate missing its resourceType or dimension", () => {
		expect(() =>
			placement({ candidates: [candidate("a", { resourceType: undefined })] }),
		).toThrow(/candidate.resourceType must be a non-empty string/u);
		expect(() =>
			placement({ candidates: [candidate("a", { dimension: undefined })] }),
		).toThrow(/candidate.dimension must be a non-empty string/u);
	});

	it("falls back from definitionId to id and from providerId to definitionId", () => {
		// The three-way fallback exists because catalogs spell the identifier
		// differently. What must not happen is a candidate silently ranking under
		// an empty id, which would collide with every other such candidate.
		const result = placement({
			candidates: [
				{
					id: "from-id",
					resourceType: "object-store",
					dimension: "object-store.gib-month",
				},
			],
			ledgerView: ledgerView([]),
		});
		expect(result.winner).toBe("from-id");
		expect(result.selectedProvider).toBe("from-id");
	});

	it("refuses a candidate with no usable identifier at all", () => {
		expect(() =>
			placement({
				candidates: [
					{ resourceType: "object-store", dimension: "object-store.gib-month" },
				],
			}),
		).toThrow(/candidate.definitionId must be a non-empty string/u);
	});

	it("defaults a non-finite specificity and a non-integer priority to zero", () => {
		// `Number.isFinite` and `Number.isInteger` rather than `??`. A NaN
		// specificity would make every comparison against it false and give the
		// candidate an arbitrary position.
		const result = placement({
			candidates: [candidate("a", { specificity: Number.NaN, priority: 1.5 })],
		});
		expect(result.ok).toBe(true);
	});

	it("drops an empty region rather than carrying it as a value", () => {
		const result = placement({ candidates: [candidate("a", { region: "" })] });
		expect(result.ok).toBe(true);
	});

	it("refuses a negative listUnitCost or switchingCost", () => {
		// A negative cost would rank as *better than free* and win every
		// comparison, which is the most direct way to misroute spend.
		expect(() =>
			placement({ candidates: [candidate("a", { listUnitCost: -1 })] }),
		).toThrow(/must be a non-negative number/u);
		expect(() =>
			placement({ candidates: [candidate("a", { switchingCost: -1 })] }),
		).toThrow(/must be a non-negative number/u);
	});
});

describe("credit fact classification", () => {
	it("reports missing when the ledger holds no matching account", () => {
		// The provider is still rankable — at its own list price — but the
		// decision records that no credit facts were available, so a reader can
		// tell "no free credit" from "we never looked".
		const result = dispatch({ ledgerView: ledgerView([]) });
		expect(result.ranking[0]?.creditFacts).toBe("missing");
	});

	it("matches an account on provider and dimension together", () => {
		// Both, not just the provider. One provider bills several dimensions, and
		// matching on the provider alone would spend an object-store credit on
		// runner minutes.
		const result = dispatch({
			ledgerView: ledgerView([
				account("a", {
					dimension: "object-store.gib-month",
					freeHeadroom: 1000,
				}),
			]),
		});
		expect(result.ranking[0]?.creditFacts).toBe("missing");
	});

	it("reports present-empty when the account exists with no free headroom", () => {
		const result = dispatch({
			ledgerView: ledgerView([runnerAccount("a", { freeHeadroom: 0 })]),
		});
		expect(result.ranking[0]?.creditFacts).toBe("present-empty");
	});

	it("reports present when free headroom is available", () => {
		const result = dispatch({
			ledgerView: ledgerView([runnerAccount("a", { freeHeadroom: 50 })]),
		});
		expect(result.ranking[0]?.creditFacts).toBe("present");
		expect(result.ranking[0]?.freeUnits).toBe(10);
		expect(result.ranking[0]?.totalCost).toBe(0);
	});

	it("reports invalid for an account carrying an unusable number", () => {
		// The important direction: invalid falls back to *no* free headroom and
		// the candidate's own list price. Treating a NaN as available capacity
		// would route paid work to a provider believing it was free.
		for (const overrides of [
			{ freeHeadroom: Number.NaN },
			{ rateHeadroom: -1 },
			{ concurrencyHeadroom: Number.POSITIVE_INFINITY },
			{ budgetCap: Number.NaN, spendToDate: 0 },
		]) {
			const result = dispatch({
				ledgerView: ledgerView([runnerAccount("a", overrides)]),
			});
			expect(result.ranking[0]?.creditFacts).toBe("invalid");
			expect(result.ranking[0]?.freeUnits).toBe(0);
		}
	});

	it("sums credit grants when the account has no top-level freeHeadroom", () => {
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", {
					freeHeadroom: undefined,
					credits: [
						{ creditId: "c1", freeHeadroom: 4 },
						{ creditId: "c2", freeHeadroom: 6 },
					],
				}),
			]),
		});
		expect(result.ranking[0]?.freeUnits).toBe(10);
	});

	it("treats a grant with an unusable headroom as poisoning the sum", () => {
		// Deliberately strict: one bad grant makes the whole account invalid
		// rather than being skipped. Silently omitting it would under-report
		// available credit in a way nobody could see from the decision.
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", {
					freeHeadroom: undefined,
					credits: [
						{ creditId: "c1", freeHeadroom: 4 },
						{ creditId: "bad", freeHeadroom: null },
					],
				}),
			]),
		});
		expect(result.ranking[0]?.creditFacts).toBe("invalid");
	});

	it("reports zero free headroom when there is neither a value nor grants", () => {
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", { freeHeadroom: undefined, credits: undefined }),
			]),
		});
		expect(result.ranking[0]?.creditFacts).toBe("present-empty");
	});

	it("falls back to the candidate's list price when the account has none", () => {
		// Visible through the effective marginal cost, which is the paid cost per
		// unit: ten paid units at the registry's 0.02 is 0.02 per unit.
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", { listUnitCost: undefined, freeHeadroom: 0 }),
			]),
		});
		expect(result.ranking[0]?.effectiveMarginalCost).toBe(0.02);
	});

	it("treats absent rate and concurrency headroom as unbounded", () => {
		// Undefined means "the ledger does not track this", which must not read
		// as zero — a zero concurrency headroom removes the provider from
		// consideration for free units entirely.
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", {
					freeHeadroom: 100,
					rateHeadroom: undefined,
					concurrencyHeadroom: undefined,
				}),
			]),
		});
		expect(result.ranking[0]?.freeUnits).toBe(10);
	});

	it("caps free units at the rate headroom", () => {
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", { freeHeadroom: 100, rateHeadroom: 3 }),
			]),
		});
		expect(result.ranking[0]?.freeUnits).toBe(3);
		expect(result.ranking[0]?.paidUnits).toBe(7);
	});

	it("yields no free units when concurrency headroom is exhausted", () => {
		// Concurrency is a gate, not a quantity: at zero, none of the free
		// headroom is reachable right now even though it exists.
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", { freeHeadroom: 100, concurrencyHeadroom: 0 }),
			]),
		});
		expect(result.ranking[0]?.freeUnits).toBe(0);
		expect(result.ranking[0]?.creditFacts).toBe("present");
	});

	it("treats an account with no budget fields as unbounded", () => {
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", { budgetCap: undefined, spendToDate: undefined }),
			]),
		});
		expect(result.ranking[0]?.budgetExceeded).toBe(false);
	});

	it("marks a candidate whose cost exceeds the remaining budget", () => {
		// Budget-exceeded is the first element of the rank vector, so such a
		// candidate loses to every within-budget one regardless of price — and is
		// still ranked rather than dropped, so the decision can explain itself
		// when every candidate is over budget.
		const result = dispatch({
			units: 100,
			ledgerView: ledgerView([
				runnerAccount("a", {
					budgetCap: 1,
					spendToDate: 0.9,
					listUnitCost: 0.5,
					freeHeadroom: 0,
				}),
			]),
		});
		expect(result.ranking[0]?.budgetExceeded).toBe(true);
	});

	it("defaults spendToDate to zero when only a cap is set", () => {
		const result = dispatch({
			units: 1,
			ledgerView: ledgerView([
				runnerAccount("a", { budgetCap: 100, listUnitCost: 0.02 }),
			]),
		});
		expect(result.ranking[0]?.budgetExceeded).toBe(false);
	});

	it("prefers the sooner-expiring credit and reports the next expiry", () => {
		// Use-it-or-lose-it: the expiry term in the rank vector exists so that
		// two equally-priced free options do not fall to the id tiebreaker and
		// let credit lapse.
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", {
					freeHeadroom: 100,
					credits: [
						{
							creditId: "later",
							freeHeadroom: 50,
							expiresAt: "2027-01-01T00:00:00.000Z",
						},
						{
							creditId: "sooner",
							freeHeadroom: 50,
							expiresAt: "2026-07-01T00:00:00.000Z",
						},
					],
				}),
			]),
		});
		expect(result.ranking[0]?.nextCreditExpiresAt).toBe(
			"2026-07-01T00:00:00.000Z",
		);
	});

	it("falls back to windowEnd when a grant has no expiresAt", () => {
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", {
					freeHeadroom: 100,
					credits: [
						{
							creditId: "c",
							freeHeadroom: 100,
							windowEnd: "2026-07-01T00:00:00.000Z",
						},
					],
				}),
			]),
		});
		expect(result.ranking[0]?.nextCreditExpiresAt).toBe(
			"2026-07-01T00:00:00.000Z",
		);
	});

	it("refuses an unparseable expiry and permits an explicitly unexpiring grant", () => {
		expect(() =>
			dispatch({
				ledgerView: ledgerView([
					runnerAccount("a", {
						freeHeadroom: 100,
						credits: [
							{ creditId: "bad", freeHeadroom: 10, expiresAt: "whenever" },
						],
					}),
				]),
			}),
		).toThrow(/credit.expiresAt must be a valid ISO/);
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", {
					freeHeadroom: 10,
					credits: [{ creditId: "none", freeHeadroom: 10 }],
				}),
			]),
		});
		expect(result.ranking[0]?.nextCreditExpiresAt).toBeNull();
	});

	it("ignores the expiry of a grant with no remaining headroom", () => {
		// An exhausted grant's expiry is irrelevant — there is nothing left to
		// lose — and letting it win the sort would prefer a provider whose free
		// credit is already spent.
		const result = dispatch({
			ledgerView: ledgerView([
				runnerAccount("a", {
					freeHeadroom: 100,
					credits: [
						{
							creditId: "spent",
							freeHeadroom: 0,
							expiresAt: "2026-06-28T00:00:00.000Z",
						},
						{
							creditId: "live",
							freeHeadroom: 100,
							expiresAt: "2026-09-01T00:00:00.000Z",
						},
					],
				}),
			]),
		});
		expect(result.ranking[0]?.nextCreditExpiresAt).toBe(
			"2026-09-01T00:00:00.000Z",
		);
	});
});

describe("ranking order", () => {
	it("prefers the candidate with free headroom over a cheaper paid one", () => {
		// The objective is maximize-credits, so a zero effective cost beats any
		// non-zero list price. Ranking by list price alone would leave free
		// credit unspent while paying for the work.
		const result = placement({
			candidates: [
				candidate("cheap", { listUnitCost: 0.001 }),
				candidate("free", { listUnitCost: 0.5 }),
			],
			ledgerView: ledgerView([
				account("cheap", { freeHeadroom: 0, listUnitCost: 0.001 }),
				account("free", { freeHeadroom: 100, listUnitCost: 0.5 }),
			]),
		});
		expect(result.winner).toBe("free");
	});

	it("breaks a true tie by provider id, so the order is total", () => {
		// This is what makes replay deterministic. Two identically-priced
		// candidates must not depend on input order, or the same inputs would
		// select different providers on different runs.
		const forward = placement({
			candidates: [candidate("b"), candidate("a")],
			ledgerView: ledgerView([account("a"), account("b")]),
		});
		const reverse = placement({
			candidates: [candidate("a"), candidate("b")],
			ledgerView: ledgerView([account("b"), account("a")]),
		});
		expect(forward.winner).toBe("a");
		expect(reverse.winner).toBe("a");
	});

	it("reports every tied candidate and flags the tie", () => {
		// The decision vector excludes the id tiebreakers, so `tiedDefinitionIds`
		// tells an operator the winner was arbitrary among equals — information
		// the rank order alone destroys.
		const result = placement({
			candidates: [candidate("a"), candidate("b")],
			ledgerView: ledgerView([account("a"), account("b")]),
		});
		expect(result.tiedDefinitionIds).toEqual(["a", "b"]);
		expect(result.matchEvent.data.tie).toBe(true);
	});

	it("does not flag a tie when one candidate wins outright", () => {
		const result = placement({
			candidates: [candidate("a"), candidate("b", { listUnitCost: 0.5 })],
			ledgerView: ledgerView([
				account("a"),
				account("b", { listUnitCost: 0.5 }),
			]),
		});
		expect(result.matchEvent.data.tie).toBe(false);
		expect(result.tiedDefinitionIds).toEqual(["a"]);
	});

	it("assigns contiguous one-based ranks", () => {
		const result = placement({
			candidates: [candidate("a"), candidate("b"), candidate("c")],
			ledgerView: ledgerView([account("a"), account("b"), account("c")]),
		});
		expect(result.ranking.map((entry) => entry.rank)).toEqual([1, 2, 3]);
	});
});

describe("switching cost", () => {
	it("is charged only to a challenger, never to the incumbent", () => {
		// Otherwise every candidate would carry it and it would cancel out,
		// which is the opposite of the intent: the cost exists to make switching
		// away from an incumbent require a real saving.
		const result = decideDispatch({
			registry: createDispatcherRegistry([
				{
					id: "a",
					category: "runner",
					dimension: "runner.minutes",
					listUnitCost: 0.02,
					switchingCost: 5,
				},
				{
					id: "b",
					category: "runner",
					dimension: "runner.minutes",
					listUnitCost: 0.02,
					switchingCost: 5,
				},
			]),
			category: "runner",
			dispatchId: "d-1",
			objective: "maximize-credits",
			units: 10,
			incumbentProviderId: "a",
			ledgerView: ledgerView([runnerAccount("a"), runnerAccount("b")]),
		});
		const byId = new Map(
			result.ranking.map((entry) => [entry.providerId, entry]),
		);
		expect(byId.get("a")?.switchingCost).toBe(0);
		expect(byId.get("b")?.switchingCost).toBe(5);
	});

	it("is charged to nobody when there is no incumbent", () => {
		const result = dispatch();
		expect(result.ranking[0]?.switchingCost).toBe(0);
	});
});

describe("catalog content hash", () => {
	it("accepts a caller-supplied sha256 ref unchanged", () => {
		const supplied =
			"sha256:3333333333333333333333333333333333333333333333333333333333333333";
		expect(
			placement({ catalogContentHash: supplied }).matchEvent.data
				.catalogContentHash,
		).toBe(supplied);
	});

	it("prefixes a bare 64-hex digest", () => {
		// Catalogs report a digest either way. Normalising here means a decision
		// fact always carries one spelling, so two facts over the same catalog
		// compare equal.
		const bare =
			"4444444444444444444444444444444444444444444444444444444444444444";
		expect(
			placement({ catalogContentHash: bare }).matchEvent.data
				.catalogContentHash,
		).toBe(`sha256:${bare}`);
	});

	it("hashes anything that is not a recognisable digest", () => {
		// Including `undefined`: the fallback hashes the candidate set itself, so
		// a decision fact always names *some* content the ranking was over.
		expect(
			placement({ catalogContentHash: "not-a-digest" }).matchEvent.data
				.catalogContentHash,
		).toMatch(/^sha256:[a-f0-9]{64}$/u);
		expect(placement().matchEvent.data.catalogContentHash).toMatch(
			/^sha256:[a-f0-9]{64}$/u,
		);
	});

	it("rejects a hex string of the wrong length or the wrong case", () => {
		// Deliberately strict. A 63-character digest is a truncated one, and
		// accepting it would let two different catalogs share a hash prefix.
		const short = "4".repeat(63);
		expect(
			placement({ catalogContentHash: short }).matchEvent.data
				.catalogContentHash,
		).not.toBe(`sha256:${short}`);
		const upper = "A".repeat(64);
		expect(
			placement({ catalogContentHash: upper }).matchEvent.data
				.catalogContentHash,
		).not.toBe(`sha256:${upper}`);
	});

	it("is stable across two runs over the same catalog", () => {
		expect(placement().matchEvent.data.catalogContentHash).toBe(
			placement().matchEvent.data.catalogContentHash,
		);
	});
});

describe("canonicalJson and stableHash", () => {
	it("sorts object keys at every depth", () => {
		// The property the whole replay guarantee rests on: two services that
		// serialize the same ledger with different key order must produce the
		// same balance hash, or every replay check would fail spuriously.
		expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
			'{"a":{"c":3,"d":2},"b":1}',
		);
	});

	it("preserves array order", () => {
		// Arrays are ordered data, not a bag. Sorting them would make a ranking
		// hash the same as its reverse.
		expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
		expect(canonicalJson([3, 1, 2])).not.toBe(canonicalJson([1, 2, 3]));
	});

	it("sorts keys inside array elements", () => {
		expect(canonicalJson([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
	});

	it("passes primitives and null through", () => {
		expect(canonicalJson(null)).toBe("null");
		expect(canonicalJson(7)).toBe("7");
		expect(canonicalJson("x")).toBe('"x"');
		expect(canonicalJson(true)).toBe("true");
	});

	it("produces a sha256-prefixed hex digest", () => {
		expect(stableHash({ a: 1 })).toMatch(/^sha256:[a-f0-9]{64}$/u);
	});

	it("hashes key-permuted objects identically and different values differently", () => {
		expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
		expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
	});
});

describe("decideDispatch registry parsing", () => {
	it("accepts a bare candidate array and builds the registry", () => {
		// Callers pass either a built registry or the raw records. Accepting both
		// keeps the one-shot call ergonomic without a second entry point.
		const decision = decideDispatch({
			registry: [
				{
					id: "r1",
					category: "runner",
					dimension: "runner.minutes",
					listUnitCost: 0.02,
				},
			],
			category: "runner",
			dispatchId: "d-1",
			objective: "maximize-credits",
			units: 5,
			ledgerView: ledgerView([]),
		});
		expect(decision.ok).toBe(true);
	});

	it("refuses an object that is not a registry", () => {
		// The shape check is on `byCategory` being a Map and `records` an array,
		// so a plain object that merely looks registry-ish is refused rather than
		// silently ranking zero candidates.
		for (const bad of [null, {}, { records: [] }, { byCategory: {} }]) {
			expect(() =>
				decideDispatch({
					registry: bad,
					category: "runner",
					dispatchId: "d-1",
					objective: "maximize-credits",
					units: 5,
					ledgerView: ledgerView([]),
				}),
			).toThrow(/must be a Dispatcher registry/u);
		}
	});

	it("refuses an unknown dispatch category", () => {
		expect(() =>
			decideDispatch({
				registry: createDispatcherRegistry([]),
				category: "gpu",
				dispatchId: "d-1",
				objective: "maximize-credits",
				units: 5,
				ledgerView: ledgerView([]),
			}),
		).toThrow(/category must be runner, build-machine, or traffic-backend/u);
	});

	it("defaults a provider's dimension from its category", () => {
		// So a registry entry need not repeat what the category already implies,
		// and a typo'd dimension cannot silently orphan the provider from its
		// ledger account.
		const registry = createDispatcherRegistry([
			{ id: "r1", category: "build-machine", listUnitCost: 0.02 },
		]);
		expect(registry.records[0]?.dimension).toBe("build.minutes");
	});
});
