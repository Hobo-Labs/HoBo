import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { DEFAULT_HAND_OFF_AUDIT_OPTIONS } from "../../packages/hobo-ci/src/hand-off-audit.ts";

const scriptPath = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"evals",
	"audit-hand-off-transcript.mts",
);

describe("audit-hand-off-transcript entry", () => {
	it("pins strict default hand-off audit options", () => {
		expect(DEFAULT_HAND_OFF_AUDIT_OPTIONS).toEqual({});
	});

	it("uses fixed default audit options with no weakening CLI flags", () => {
		const source = readFileSync(scriptPath, "utf8");
		expect(source).toMatch(/DEFAULT_HAND_OFF_AUDIT_OPTIONS/u);
		expect(source).not.toMatch(/owner-form-unavailable/u);
		expect(source).not.toMatch(/owner-form-privacy-verified/u);
		expect(source).not.toMatch(/parseArgs|minimist|yargs/u);
	});

	it("accepts only transcript paths from argv", () => {
		const source = readFileSync(scriptPath, "utf8");
		expect(source).toMatch(/process\.argv\.slice\(2\)/u);
	});
});
