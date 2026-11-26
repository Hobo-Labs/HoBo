/**
 * Re-evaluating a placement decision.
 *
 * Written before the implementation. `match.Decided` records where a workload
 * was placed and why, once. Catalogs gain and lose offerings, jurisdictions
 * change, objectives change — and nothing revisits the decision, so a placement
 * that was right on Tuesday stays recorded as right forever.
 *
 * The mechanism here is deliberately *not* an optimizer. It answers one
 * question — has an input changed such that the decision might now be
 * different, and are we permitted to act on that? — and leaves the actual
 * re-matching to the existing planner. Splitting it that way is what keeps
 * re-placement explainable: the verdict names the input that changed, so a
 * workload that moves at 3am can say why.
 *
 * Three rules the tests exist to hold:
 *
 *   - **No change, no churn.** Identical inputs must produce `hold`. A
 *     re-evaluator that re-decides on every tick is a workload shuffler.
 *   - **Residency outranks opportunity.** Moving to cheaper or newer capacity
 *     is a jurisdiction decision (ADR-0146). A re-placement that would land
 *     somewhere residency forbids is `blocked`, never silently skipped.
 *   - **Movement needs consent.** A workload that has not declared it tolerates
 *     interruption does not get moved for a mere improvement (ADR-0136). Being
 *     *forced* to move — the current placement became invalid — is different
 *     from being *able* to improve.
 */
import { describe, expect, it } from "vitest";

import {
	evaluateReplacement,
	type ReplacementInputs,
} from "../src/planner/replacement.js";

const PRIOR = {
	deploymentId: "d1",
	resource: "web",
	region: "us-east-1",
	catalogContentHash: "sha256:catalog-v1",
	objective: "cost",
} as const;

function inputs(overrides: Partial<ReplacementInputs> = {}): ReplacementInputs {
	return {
		prior: { ...PRIOR },
		catalogContentHash: "sha256:catalog-v1",
		objective: "cost",
		interruptible: false,
		...overrides,
	};
}

describe("nothing changed", () => {
	it("holds when every input matches the prior decision", () => {
		const verdict = evaluateReplacement(inputs());
		expect(verdict.action).toBe("hold");
		expect(verdict.reasons).toEqual([]);
	});

	it("holds even for an interruptible workload — tolerance is not a reason to move", () => {
		// Being willing to move is not the same as having a reason to.
		expect(evaluateReplacement(inputs({ interruptible: true })).action).toBe(
			"hold",
		);
	});
});

describe("the catalog changed", () => {
	it("is an opportunity, not an obligation", () => {
		const verdict = evaluateReplacement(
			inputs({ catalogContentHash: "sha256:catalog-v2", interruptible: true }),
		);
		expect(verdict.action).toBe("re-decide");
		expect(verdict.reasons).toContain("catalog-changed");
	});

	it("does not move a workload that has not consented to interruption", () => {
		const verdict = evaluateReplacement(
			inputs({ catalogContentHash: "sha256:catalog-v2", interruptible: false }),
		);
		expect(verdict.action).toBe("hold");
		// The opportunity is still named, so it can be surfaced without acting.
		expect(verdict.reasons).toContain("catalog-changed");
		expect(verdict.deferred).toBe(true);
	});
});

describe("the objective changed", () => {
	it("is an opportunity for an interruptible workload", () => {
		const verdict = evaluateReplacement(
			inputs({ objective: "latency", interruptible: true }),
		);
		expect(verdict.action).toBe("re-decide");
		expect(verdict.reasons).toContain("objective-changed");
	});

	it("is deferred for a workload that cannot be interrupted", () => {
		const verdict = evaluateReplacement(
			inputs({ objective: "latency", interruptible: false }),
		);
		expect(verdict.action).toBe("hold");
		expect(verdict.deferred).toBe(true);
	});
});

describe("residency", () => {
	it("forces a re-decision when the current region is no longer permitted", () => {
		// This is not an optimization. The placement has become invalid, and
		// consent to interruption is irrelevant to a placement that must move.
		const verdict = evaluateReplacement(
			inputs({ residencyOk: false, interruptible: false }),
		);
		expect(verdict.action).toBe("re-decide");
		expect(verdict.reasons).toContain("residency-violated");
		expect(verdict.forced).toBe(true);
	});

	it("outranks a mere opportunity in the same evaluation", () => {
		const verdict = evaluateReplacement(
			inputs({
				residencyOk: false,
				catalogContentHash: "sha256:catalog-v2",
				interruptible: true,
			}),
		);
		expect(verdict.action).toBe("re-decide");
		expect(verdict.forced).toBe(true);
		expect(verdict.reasons).toContain("residency-violated");
	});

	it("blocks an opportunistic move when no permitted region is available", () => {
		// Better capacity exists but every candidate region is forbidden. Saying
		// `hold` would hide a real problem; `re-decide` would hand the planner an
		// unsatisfiable request.
		const verdict = evaluateReplacement(
			inputs({
				catalogContentHash: "sha256:catalog-v2",
				interruptible: true,
				permittedRegions: [],
			}),
		);
		expect(verdict.action).toBe("blocked");
		expect(verdict.reasons).toContain("no-permitted-region");
	});

	it("blocks a forced move with nowhere lawful to go", () => {
		// The worst case, and the one that must never be silent: the current
		// placement is unlawful and no lawful alternative exists.
		const verdict = evaluateReplacement(
			inputs({ residencyOk: false, permittedRegions: [] }),
		);
		expect(verdict.action).toBe("blocked");
		expect(verdict.reasons).toEqual(
			expect.arrayContaining(["residency-violated", "no-permitted-region"]),
		);
	});

	it("permits a forced move when a lawful region remains", () => {
		const verdict = evaluateReplacement(
			inputs({ residencyOk: false, permittedRegions: ["eu-west-1"] }),
		);
		expect(verdict.action).toBe("re-decide");
	});
});

describe("explainability", () => {
	it("names every reason, so a 3am move can be justified", () => {
		const verdict = evaluateReplacement(
			inputs({
				catalogContentHash: "sha256:catalog-v2",
				objective: "latency",
				interruptible: true,
			}),
		);
		expect(verdict.reasons.sort()).toEqual([
			"catalog-changed",
			"objective-changed",
		]);
	});

	it("carries the prior decision forward so the move is a diff, not a replacement", () => {
		const verdict = evaluateReplacement(
			inputs({ catalogContentHash: "sha256:catalog-v2", interruptible: true }),
		);
		expect(verdict.prior).toEqual(PRIOR);
	});

	it("orders reasons deterministically", () => {
		const once = evaluateReplacement(
			inputs({
				catalogContentHash: "sha256:catalog-v2",
				objective: "latency",
				interruptible: true,
			}),
		);
		const twice = evaluateReplacement(
			inputs({
				catalogContentHash: "sha256:catalog-v2",
				objective: "latency",
				interruptible: true,
			}),
		);
		expect(once).toEqual(twice);
	});

	it("does not mutate its inputs", () => {
		const input = inputs({ catalogContentHash: "sha256:catalog-v2" });
		const before = structuredClone(input);
		evaluateReplacement(input);
		expect(input).toEqual(before);
	});
});

describe("defaults", () => {
	it("treats residency as satisfied unless told otherwise", () => {
		// Note this is the *evaluated* result being passed in, not an assumption:
		// the caller runs evaluateResidency and reports it. Defaulting to true
		// here would be fail-open, so the field is required to say false.
		expect(evaluateReplacement(inputs()).action).toBe("hold");
	});

	it("treats a workload as non-interruptible unless it says otherwise", () => {
		const verdict = evaluateReplacement({
			prior: { ...PRIOR },
			catalogContentHash: "sha256:catalog-v2",
			objective: "cost",
		});
		expect(verdict.action).toBe("hold");
		expect(verdict.deferred).toBe(true);
	});
});
