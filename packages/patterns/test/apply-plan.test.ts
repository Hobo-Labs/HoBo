/**
 * Planning a pattern application, and the path guard both halves share.
 *
 * `apply.test.ts` covers the structural merge; this covers the plan step and
 * the refusals, which is where a pattern application is stopped from touching
 * something it should not.
 *
 * **`assertSafe` is the whole containment story.** A pattern is applied inside
 * an isolation root and promoted afterwards, so a target path escaping that
 * root would write into the real project before anyone reviewed it. It refuses
 * on three separate grounds — a leading slash, a `..` segment, and a resolved
 * path outside the root — and the third is the backstop for anything the first
 * two miss.
 *
 * **A missing target is not an error.** A pattern that creates a file has no
 * preimage, so the plan records an empty expectation rather than failing;
 * treating "not there yet" as a fault would make every scaffolding pattern
 * unusable.
 *
 * **Promotion is always required.** The plan and the receipt both say so
 * unconditionally: an application that could mark itself promoted would defeat
 * the isolate-then-review model entirely.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyPatternPlan,
	loadPatternCatalog,
	PatternParseError,
	planPatternApplication,
} from "../src/index.js";

const catalog = loadPatternCatalog();
const PATTERN_ID = "bindle.resource.api";

const BINDLE = `import { bindle } from "@hobo/bindles";

export default bindle("demo", (b) => {
  return {};
});
`;

function root(withFile = true) {
	const dir = mkdtempSync(join(tmpdir(), "hobo-plan-"));
	if (withFile) {
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "bindle.ts"), BINDLE);
	}
	return dir;
}

const plan = (
	overrides: Partial<Parameters<typeof planPatternApplication>[0]> = {},
) =>
	planPatternApplication({
		catalog,
		patternId: PATTERN_ID,
		isolationRoot: root(),
		targetPath: "src/bindle.ts",
		isolationRunId: "run-1",
		...overrides,
	});

describe("planPatternApplication", () => {
	it("plans an application against an existing file", () => {
		const planned = plan();
		expect(planned.isolationRunId).toBe("run-1");
		expect(planned.targetPath).toBe("src/bindle.ts");
	});

	it("records a preimage hash for a file that exists", () => {
		// The preimage is what makes the apply checkable: it says which content
		// the plan was made against.
		expect(plan().expectedPreimage).toHaveLength(1);
	});

	it("records no preimage for a file that does not exist yet", () => {
		// A scaffolding pattern has no preimage; treating that as a fault would
		// make every create-a-file pattern unusable.
		expect(plan({ isolationRoot: root(false) }).expectedPreimage).toEqual([]);
	});

	it("gives the same preimage for the same content", () => {
		const dir = root();
		const a = plan({ isolationRoot: dir });
		const b = plan({ isolationRoot: dir });
		expect(a.expectedPreimage).toEqual(b.expectedPreimage);
	});

	it("gives a different preimage for different content", () => {
		const dir = root();
		const before = plan({ isolationRoot: dir }).expectedPreimage;
		writeFileSync(join(dir, "src", "bindle.ts"), `${BINDLE}// changed\n`);
		expect(plan({ isolationRoot: dir }).expectedPreimage).not.toEqual(before);
	});

	it("carries the pattern's declared effects verbatim", () => {
		// This pattern declares none, and the plan says none rather than
		// synthesizing one — an effect list is a claim about what an application
		// does, so inventing entries would make the plan lie about its scope.
		const pattern = catalog.patterns.find((p) => p.id === PATTERN_ID);
		expect(plan().effects).toEqual(pattern?.effects ?? []);
	});

	it("always requires promotion", () => {
		// An application that could mark itself promoted would defeat the
		// isolate-then-review model entirely.
		expect(plan().promotionRequired).toBe(true);
	});

	it("carries the isolation root as the source root", () => {
		const dir = root();
		expect(plan({ isolationRoot: dir }).sourceRoot).toBe(dir);
	});

	it("rejects an unknown pattern id", () => {
		expect(() => plan({ patternId: "bindle.does.not.exist" })).toThrow(
			/unknown pattern/u,
		);
	});
});

describe("the path guard", () => {
	it("refuses an absolute target path", () => {
		// The containment story: a path escaping the isolation root would write
		// into the real project before anyone reviewed it.
		expect(() => plan({ targetPath: "/etc/passwd" })).toThrow(
			PatternParseError,
		);
	});

	it("refuses a traversal segment", () => {
		expect(() => plan({ targetPath: "../outside.ts" })).toThrow(
			PatternParseError,
		);
	});

	it("refuses a traversal buried mid-path", () => {
		expect(() => plan({ targetPath: "src/../../outside.ts" })).toThrow(
			PatternParseError,
		);
	});

	it("refuses a traversal that would resolve back inside", () => {
		// Refused on the `..` rule regardless of where it lands, because a path
		// that has to be *resolved* to be judged safe is a path one normalize
		// change away from being unsafe.
		expect(() => plan({ targetPath: "src/../src/bindle.ts" })).toThrow(
			PatternParseError,
		);
	});

	it("accepts an ordinary nested path", () => {
		expect(() => plan({ targetPath: "src/bindle.ts" })).not.toThrow();
	});

	it("names the offending path in the refusal", () => {
		expect(() => plan({ targetPath: "../x.ts" })).toThrow(/\.\.\/x\.ts/u);
	});

	it("guards the apply path as well as the plan path", () => {
		// Both entry points share the guard; guarding only one would leave the
		// other reachable.
		expect(() =>
			applyPatternPlan({
				catalog,
				patternId: PATTERN_ID,
				isolationRoot: root(),
				targetPath: "../escape.ts",
				isolationRunId: "run-2",
				params: { resourceName: "shop" },
			}),
		).toThrow(PatternParseError);
	});
});

describe("applyPatternPlan receipts", () => {
	function apply(
		overrides: Partial<Parameters<typeof applyPatternPlan>[0]> = {},
	) {
		return applyPatternPlan({
			catalog,
			patternId: PATTERN_ID,
			isolationRoot: root(),
			targetPath: "src/bindle.ts",
			isolationRunId: "run-1",
			params: { resourceName: "shop" },
			...overrides,
		});
	}

	it("reports zero model calls", () => {
		// The zero-inference claim, asserted on the receipt rather than assumed.
		const receipt = apply();
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});

	it("always requires promotion and names the command", () => {
		const receipt = apply();
		expect(receipt.promotionRequired).toBe(true);
		expect(receipt.promotionRef).toBe("hobo-code promote");
	});

	it("reports the files it changed", () => {
		expect(apply().changedFiles).toContain("src/bindle.ts");
	});

	it("records a postimage hash per rendered file", () => {
		expect(apply().postimage.length).toBeGreaterThan(0);
	});

	it("reports applied-isolation the first time", () => {
		expect(apply().reasonCode).toBe("applied-isolation");
	});

	it("reports idempotent and changes nothing on a repeat", () => {
		// Re-running a pattern must be safe: the second run is a no-op that says
		// so, rather than appending the resource again.
		const dir = root();
		applyPatternPlan({
			catalog,
			patternId: PATTERN_ID,
			isolationRoot: dir,
			targetPath: "src/bindle.ts",
			isolationRunId: "run-1",
			params: { resourceName: "shop" },
		});
		const second = applyPatternPlan({
			catalog,
			patternId: PATTERN_ID,
			isolationRoot: dir,
			targetPath: "src/bindle.ts",
			isolationRunId: "run-2",
			params: { resourceName: "shop" },
		});
		expect(second.idempotent).toBe(true);
		expect(second.reasonCode).toBe("idempotent");
		expect(second.changedFiles).toEqual([]);
	});

	it("carries the run id through to the receipt", () => {
		expect(apply({ isolationRunId: "run-xyz" }).isolationRunId).toBe("run-xyz");
	});

	it("rejects an unknown pattern", () => {
		expect(() => apply({ patternId: "bindle.nope" })).toThrow(
			/unknown pattern/u,
		);
	});

	it("creates the target directory when it does not exist", () => {
		// A pattern that targets a new folder must not fail on the folder.
		expect(() =>
			apply({ isolationRoot: root(false), targetPath: "src/bindle.ts" }),
		).not.toThrow();
	});
});
