/**
 * `LONG_TOKEN_RUN_PROFILE`, the profile six providers share, tested once here
 * rather than six times: what its rule caught is still caught, and on 5k
 * generated texts it hides every marker the two-line rule it replaced hid. The
 * deep tier (`long-token-profile.deep.test.ts`) runs 50k texts on three seeds,
 * its growth on hostile text, and its sweep.
 */
import { assertRevealsNoMore } from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import {
	createProviderRedactor,
	KEPT_LOCATOR,
	LONG_TOKEN_RUN_PROFILE,
} from "../src/provider-redaction.js";
import { redactLongTokens } from "./fixtures/long-token-base.js";

const redact = createProviderRedactor(LONG_TOKEN_RUN_PROFILE);
const LONG = 1_000_000;

describe("the long-token profile", () => {
	it("redacts every long token-shaped run, and the shapes the rule missed", () => {
		expect(redact(`denied for ${"A1b2".repeat(8)} here`, 400)).toBe(
			"denied for [redacted] here",
		);
		for (const secret of [
			"password=hunter2",
			"Bearer abc123",
			"https://user:pw@host/x",
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
		])
			expect(redact(`denied ${secret} here`, 400)).toBe(
				"denied [redacted] here",
			);
	});

	it("on 5k texts, hides every marker the rule it replaced hid", () => {
		const hidden = assertRevealsNoMore(
			(text) => redactLongTokens(text, LONG),
			(text) => redact(text, LONG),
			{ count: 5_000, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(500);
	});
});
