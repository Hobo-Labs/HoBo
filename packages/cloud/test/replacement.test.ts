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
