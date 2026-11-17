import {
	KEPT_LOCATOR,
	redactionPattern,
	redactMatches,
} from "@hobo/provider-redaction";
import {
	asGlobal,
	assertPatternSweepLinear,
	type PatternSearch,
	profilePatterns,
} from "@hobo/redaction-test-harness/linear-sweep";
import {
	assertGrowsLinearly,
	repeatedTo,
} from "@hobo/redaction-test-harness/linear-time";
import {
	assertRevealsNoMore,
	DEEP_SEEDS,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import {
	KUBERNETES_REDACTION_PROFILE,
	redactClusterText,
} from "../src/errors.js";
import { redactClusterText as baseRedact } from "./fixtures/base-redaction.js";

const searchAsRedactor: PatternSearch = (text, pattern) => {
	redactMatches(text, [redactionPattern(asGlobal(pattern))]);
};

const MB = 1_000_000;

describe("redactClusterText", () => {
	it.each([
		["-eyJ", repeatedTo("-eyJ")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		['"auths":{ with no closing brace', repeatedTo('"auths":{')],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 600_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactClusterText(text, 8 * MB);
			}, input);
		},
	);
});

describe("against the redactor it replaced", () => {
	const LONG = 1_000_000;
	it.each(
		DEEP_SEEDS,
	)("hides every marker the base branch's redactor hid (seed %i)", {
		timeout: 600_000,
	}, (seed) => {
		const hidden = assertRevealsNoMore(
			(text) => baseRedact(text, LONG),
			(text) => redactClusterText(text, LONG),
			{ count: 50_000, seed, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(1000);
	});
	it.each(
		profilePatterns(KUBERNETES_REDACTION_PROFILE).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)(
		"its pattern /%s/ grows linearly on the whole sweep",
		{ timeout: 600_000 },
		(_source, pattern) => {
			assertPatternSweepLinear(pattern, searchAsRedactor);
		},
	);
});
