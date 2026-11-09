/**
 * `redactSecrets` and `looksLikeSecret` take the shared linear JWT pattern
 * (`@hobo/core/provider-redaction`). Their own `\beyJ…` pattern started again
 * at every `eyJ` in a run and read to its end, so a runner log holding a
 * megabyte of `-eyJ` stalled both. These pin that a JWT is still found and
 * redacted, and that both are linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { looksLikeSecret, redactSecrets } from "../src/runner-integrations.js";

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
