import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
	auditHandOff,
	DEFAULT_HAND_OFF_AUDIT_OPTIONS,
	parseClaudeTranscript,
} from "../../packages/hobo-ci/src/hand-off-audit.ts";

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
		expect(source).toMatch(/arg\.startsWith\("-"\)/u);
	});

	it("default options stay at least as strict as the legacy CLI defaults", () => {
		const events = parseClaudeTranscript(
			[
				"{",
				'"type":"assistant",',
				'"message":{"content":[{"type":"text","text":"This host cannot provide a secure HoBo owner hand-off."}]},',
				'"timestamp":1',
				"}",
			].join(""),
		);
		const legacy = auditHandOff(events, {
			ownerFormAvailable: true,
			ownerFormPrivacyVerified: false,
		});
		const current = auditHandOff(events, DEFAULT_HAND_OFF_AUDIT_OPTIONS);
		expect(current.length).toBeGreaterThanOrEqual(legacy.length);
	});
});
