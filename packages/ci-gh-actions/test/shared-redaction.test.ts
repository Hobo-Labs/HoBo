/**
 * `redactSecrets` and `looksLikeSecret` take the shared linear JWT pattern
 * (`@hobo/core/provider-redaction`). Their own `\beyJ…` pattern started again
 * at every `eyJ` in a run and read to its end, so a runner log holding a
 * megabyte of `-eyJ` stalled both. These pin that a JWT is still found and
 * redacted, and that both are linear.
 */

import { assertSweepLinear } from "@hobo/core/linear-sweep";
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { assertRevealsNoMore } from "@hobo/core/redaction-differential";
import { describe, expect, it } from "vitest";

import { looksLikeSecret, redactSecrets } from "../src/runner-integrations.js";
import { redactSecrets as baseRedactSecrets } from "./fixtures/base-redaction.js";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnaXRodWIifQ.c2lnbmF0dXJlLXZhbHVl";

describe("runner-integration secret patterns", () => {
	it("still finds and redacts a JWT, alone or after a hyphen", () => {
		for (const text of [JWT, `x-${JWT}`]) {
			expect(looksLikeSecret(text)).toBe(true);
			expect(redactSecrets(`log ${text} done`)).toBe("log [REDACTED] done");
		}
	});

	it("does not count an unsigned token, nor swallow what follows a signature", () => {
		expect(looksLikeSecret("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.")).toBe(false);
		expect(redactSecrets(`{"jwt":"${JWT}","next":"kept"}`)).toBe(
			'{"jwt":"[REDACTED]","next":"kept"}',
		);
	});

	it.each([
		["-eyJ", repeatedTo("-eyJ")],
		["-eyJ signed and short", repeatedTo("-eyJAAAAAAAA.AAAAAAAA.")],
		["eyJ runs ending in a dot", repeatedTo("-eyJAAAAAAAA.")],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactSecrets(text);
			}, input);
			assertGrowsLinearly((text) => {
				looksLikeSecret(text);
			}, input);
		},
	);
});

// Against the redactor as it stood before (vendored under test/fixtures): on
// generated texts full of credential shapes and control characters, every
// marker half the old one hid stays hidden; and it is linear on runs of every
// character class and pair of them.
describe("redactSecrets against the redactor it replaced", () => {
	it("hides every marker the old redactor hid", { timeout: 60_000 }, () => {
		expect(
			assertRevealsNoMore(
				(text) => baseRedactSecrets(text, []),
				(text) => redactSecrets(text, []),
				{ count: 50_000 },
			),
		).toBeGreaterThan(1000);
	});

	it("finds a key whose BEGIN line a key before it took", () => {
		// Replaced in turn, the first key's END line took the BEGIN glued after
		// it, and the second key was not found.
		const two =
			"-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY----------BEGIN PRIVATE KEY-----SECRPEM2 x";
		expect(redactSecrets(two)).not.toContain("SECRPEM2");
	});

	it("grows linearly on the whole sweep", { timeout: 60_000 }, () => {
		assertSweepLinear((text) => redactSecrets(text, []), {
			alphabet: "aZ9",
			words: ["ghp_", "eyJ", "-----BEGIN PRIVATE KEY-----", "sk_live_", "AKIA"],
		});
	});
});
