import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const PLAIN = `import { bindle } from "@hobo/bindles";

export default bindle("demo", (b) => {
  return {};
});
`;

let runCounter = 0;

function root(source?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-pat-plan-"));
	mkdirSync(join(dir, "src"), { recursive: true });
	if (source !== undefined) {
		writeFileSync(join(dir, "src", "bindle.ts"), source);
	}
	return dir;
}

const read = (dir: string) =>
	readFileSync(join(dir, "src", "bindle.ts"), "utf8");

function plan(
	dir: string,
	overrides: Partial<Parameters<typeof planPatternApplication>[0]> = {},
) {
	runCounter += 1;
	return planPatternApplication({
		catalog,
		patternId: "bindle.resource.api",
		isolationRoot: dir,
		targetPath: "src/bindle.ts",
		isolationRunId: `plan-${runCounter}`,
		...overrides,
	});
}

function apply(
	dir: string,
	overrides: Partial<Parameters<typeof applyPatternPlan>[0]> = {},
) {
	runCounter += 1;
	return applyPatternPlan({
		catalog,
		patternId: "bindle.resource.api",
		isolationRoot: dir,
		targetPath: "src/bindle.ts",
		isolationRunId: `apply-${runCounter}`,
		params: { resourceName: "shop" },
		...overrides,
	});
}

describe("planPatternApplication", () => {
	it("names the run, the root, and the target it will act on", () => {
		const dir = root(PLAIN);
		const result = plan(dir);
		expect(result.sourceRoot).toBe(dir);
		expect(result.targetPath).toBe("src/bindle.ts");
		expect(result.isolationRunId).toMatch(/^plan-/u);
	});

	it("digests the file as it stands, so a later change is detectable", () => {
		const dir = root(PLAIN);
		expect(plan(dir).expectedPreimage).toEqual([
			createHash("sha256").update(PLAIN).digest("hex"),
		]);
	});

	it("reports an empty preimage for a file that does not exist yet", () => {
		expect(plan(root()).expectedPreimage).toEqual([]);
	});

	it("carries the pattern's declared effects, which may legitimately be none", () => {
		const pattern = catalog.patterns.find(
			(item) => item.id === "bindle.resource.api",
		);
		expect(plan(root(PLAIN)).effects).toEqual(pattern?.effects);
	});

	it("always requires promotion", () => {
		expect(plan(root(PLAIN)).promotionRequired).toBe(true);
	});

	it("refuses a pattern the catalog does not contain", () => {
		expect(() => plan(root(PLAIN), { patternId: "bindle.nope" })).toThrow(
			/unknown pattern bindle\.nope/u,
		);
	});

	it("refuses an absolute target path", () => {
		expect(() => plan(root(PLAIN), { targetPath: "/etc/passwd" })).toThrow(
			PatternParseError,
		);
	});

	it("refuses a target path containing a dot segment", () => {
		for (const targetPath of [
			"../outside.ts",
			"src/../../outside.ts",
			"src/..",
			"a/../../b.ts",
		]) {
			expect(() => plan(root(PLAIN), { targetPath })).toThrow(
				PatternParseError,
			);
		}
	});

	it("accepts a nested path inside the root", () => {
		expect(() =>
			plan(root(PLAIN), { targetPath: "src/nested/deep/bindle.ts" }),
		).not.toThrow();
	});
});

describe("applyPatternPlan on files it cannot safely edit", () => {
	it("refuses a file carrying two bindle definitions", () => {
		const dir = root(`import { bindle } from "@hobo/bindles";

export const a = bindle("a", (b) => {
  return {};
});

export const c = bindle("c", (b) => {
  return {};
});
`);
		expect(() => apply(dir)).toThrow(/multiple ambiguous Bindle definitions/u);
	});

	it("refuses a file that mentions bindle but declares none", () => {
		const dir = root(`import { bindle } from "@hobo/bindles";

// export default bindle("demo", (b) => ({}));
const make = () => bindle;
export default make()("demo", (b) => ({}));
`);
		expect(() => apply(dir)).toThrow(
			/dynamic code shapes that cannot be safely transformed/u,
		);
	});

	it("refuses a TypeScript file with no bindle shape at all", () => {
		const dir = root(`export const answer = 42;\n`);
		expect(() => apply(dir)).toThrow(
			/unsupported language or non-TypeScript merge/u,
		);
	});

	it("reaches the structural refusal once the target mentions a bindle call", () => {
		const dir = root(`import { bindle } from "@hobo/bindles";

// bindle( appears only in this comment
export const answer = 42;
`);
		expect(() => apply(dir)).toThrow(
			/dynamic code shapes that cannot be safely transformed/u,
		);
	});

	it("refuses a target whose own source does not parse", () => {
		const dir = root(`import { bindle } from "@hobo/bindles";

export default bindle("demo", (b) => {
  return {
});
`);
		expect(() => apply(dir)).toThrow(/target has source syntax errors/u);
	});

	it("names the syntax error it found in the target", () => {
		const dir = root(`export default bindle("demo", (b) => { return { ;\n`);
		try {
			apply(dir);
			expect.unreachable("a malformed target must be refused");
		} catch (error) {
			expect(error).toBeInstanceOf(PatternParseError);
			if (!(error instanceof Error)) throw error;
			expect(error.message.length).toBeGreaterThan(
				"target has source syntax errors: ".length,
			);
		}
	});

	it("refuses a non-TypeScript file rather than appending to it", () => {
		const dir = root();
		writeFileSync(
			join(dir, "src", "bindle.ts"),
			"# not typescript\n\n- a\n- b\n",
		);
		expect(() => apply(dir)).toThrow(
			/unsupported language or non-TypeScript merge/u,
		);
	});

	it("leaves the file untouched when it refuses", () => {
		const source = `export const answer = 42;\n`;
		const dir = root(source);
		expect(() => apply(dir)).toThrow();
		expect(read(dir)).toBe(source);
	});

	it("refuses a pattern the catalog does not contain", () => {
		expect(() => apply(root(PLAIN), { patternId: "bindle.nope" })).toThrow(
			/unknown pattern/u,
		);
	});
});

describe("applyPatternPlan on an empty or absent target", () => {
	it("creates the file when there is nothing there", () => {
		const dir = root();
		const receipt = apply(dir);
		expect(receipt.changedFiles).toContain("src/bindle.ts");
		expect(read(dir).length).toBeGreaterThan(0);
	});

	it("creates intermediate directories", () => {
		const dir = root();
		apply(dir, { targetPath: "src/deep/nested/bindle.ts" });
		expect(
			readFileSync(join(dir, "src", "deep", "nested", "bindle.ts"), "utf8")
				.length,
		).toBeGreaterThan(0);
	});

	it("writes the snippet verbatim into an empty file, ending with a newline", () => {
		const dir = root("");
		apply(dir);
		expect(read(dir).endsWith("\n")).toBe(true);
	});

	it("treats a whitespace-only file as empty rather than as a merge target", () => {
		const dir = root("   \n\n  ");
		expect(() => apply(dir)).not.toThrow();
		expect(read(dir)).toContain("b.api(");
	});
});

describe("the receipt an apply returns", () => {
	it("reports the files it changed and their post-image digests", () => {
		const dir = root(PLAIN);
		const receipt = apply(dir);
		expect(receipt.changedFiles).toEqual(["src/bindle.ts"]);
		expect(receipt.postimage).toEqual([
			createHash("sha256").update(read(dir)).digest("hex"),
		]);
	});

	it("reports applied-isolation for a real change", () => {
		const receipt = apply(root(PLAIN));
		expect(receipt.idempotent).toBe(false);
		expect(receipt.reasonCode).toBe("applied-isolation");
		expect(receipt.changedFiles.length).toBeGreaterThan(0);
	});

	it("reports idempotent, and changes nothing, on a second identical apply", () => {
		const dir = root(PLAIN);
		apply(dir);
		const after = read(dir);
		const second = apply(dir);
		expect(second.idempotent).toBe(true);
		expect(second.reasonCode).toBe("idempotent");
		expect(second.changedFiles).toEqual([]);
		expect(read(dir)).toBe(after);
	});

	it("still reports a post-image on an idempotent apply", () => {
		const dir = root(PLAIN);
		apply(dir);
		expect(apply(dir).postimage).toHaveLength(1);
	});

	it("always requires promotion and names how", () => {
		const receipt = apply(root(PLAIN));
		expect(receipt.promotionRequired).toBe(true);
		expect(receipt.promotionRef).toBe("caller-promotes");
	});

	it("records that no model was called", () => {
		const receipt = apply(root(PLAIN));
		expect(receipt.llmCalls).toBe(0);
		expect(receipt.llmInputTokens).toBe(0);
		expect(receipt.llmOutputTokens).toBe(0);
	});

	it("carries the run id it was given", () => {
		const receipt = applyPatternPlan({
			catalog,
			patternId: "bindle.resource.api",
			isolationRoot: root(PLAIN),
			targetPath: "src/bindle.ts",
			isolationRunId: "run-fixed",
			params: { resourceName: "shop" },
		});
		expect(receipt.isolationRunId).toBe("run-fixed");
	});
});

describe("path safety at apply time", () => {
	it("refuses a traversing target path", () => {
		for (const targetPath of ["../escape.ts", "src/../../escape.ts"]) {
			expect(() => apply(root(PLAIN), { targetPath })).toThrow(
				PatternParseError,
			);
		}
	});

	it("refuses an absolute target path", () => {
		expect(() => apply(root(PLAIN), { targetPath: "/tmp/escape.ts" })).toThrow(
			PatternParseError,
		);
	});

	it("writes nothing outside the isolation root when it refuses", () => {
		const dir = root(PLAIN);
		expect(() => apply(dir, { targetPath: "../escaped.ts" })).toThrow();
		expect(read(dir)).toBe(PLAIN);
	});
});
