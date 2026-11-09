/**
 * `redactSecrets` and `looksLikeSecret` take the shared linear JWT pattern
 * (`@hobo/provider-redaction`). Their own `\beyJ…` pattern started again
 * at every `eyJ` in a run and read to its end, so a runner log holding a
 * megabyte of `-eyJ` stalled both. These pin that a JWT is still found and
 * redacted, and that both are linear.
 *
 * This is the fast tier: `shared-redaction.deep.test.ts` holds the sweeps, the
 * growth measurements and the full-size differential (`pnpm run test:deep`).
 */

import { KEPT_LOCATOR } from "@hobo/provider-redaction";
import { assertRevealsNoMore } from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import { looksLikeSecret, redactSecrets } from "../src/runner-integrations.js";
import { redactSecrets as baseRedactSecrets } from "./fixtures/base-redaction.js";

const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJnaXRodWIifQ.c2lnbmF0dXJlLXZhbHVl";

describe("runner-integration secret patterns", () => {
	it("still finds and redacts a JWT, alone or after a hyphen", () => {
		for (const before of ["", "x-"]) {
			expect(looksLikeSecret(`${before}${JWT}`)).toBe(true);
			// The word before a hyphen is kept, as #1773 keeps it.
			expect(redactSecrets(`log ${before}${JWT} done`)).toBe(
				`log ${before}[REDACTED] done`,
			);
		}
	});

	it("does not count an unsigned token, nor swallow what follows a signature", () => {
		expect(looksLikeSecret("eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.")).toBe(false);
		expect(redactSecrets(`{"jwt":"${JWT}","next":"kept"}`)).toBe(
			'{"jwt":"[REDACTED]","next":"kept"}',
		);
	});
});

// Against the redactor as it stood before (vendored under test/fixtures): on
// generated texts full of credential shapes and control characters, every
// marker half the old one hid stays hidden; and it is linear on runs of every
// character class and pair of them.
describe("redactSecrets against the redactor it replaced", () => {
	it("on 5k texts, hides every marker the old redactor hid", () => {
		expect(
			assertRevealsNoMore(
				(text) => baseRedactSecrets(text, []),
				(text) => redactSecrets(text, []),
				{ count: 5_000, kept: KEPT_LOCATOR },
			),
		).toBeGreaterThan(500);
	});

	it("finds a key whose BEGIN line a key before it took", () => {
		// Replaced in turn, the first key's END line took the BEGIN glued after
		// it, and the second key was not found.
		const two =
			"-----BEGIN PRIVATE KEY-----\nA\n-----END PRIVATE KEY----------BEGIN PRIVATE KEY-----SECRPEM2 x";
		expect(redactSecrets(two)).not.toContain("SECRPEM2");
	});
});
