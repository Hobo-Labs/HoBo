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
		expect(plan().expectedPreimage).toHaveLength(1);
	});

	it("records no preimage for a file that does not exist yet", () => {
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
		const pattern = catalog.patterns.find((p) => p.id === PATTERN_ID);
		expect(plan().effects).toEqual(pattern?.effects ?? []);
	});

	it("always requires promotion", () => {
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
		const receipt = apply();
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});

	it("always requires promotion and names the command", () => {
		const receipt = apply();
		expect(receipt.promotionRequired).toBe(true);
		expect(receipt.promotionRef).toBe("caller-promotes");
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
		expect(() =>
			apply({ isolationRoot: root(false), targetPath: "src/bindle.ts" }),
		).not.toThrow();
	});
});
