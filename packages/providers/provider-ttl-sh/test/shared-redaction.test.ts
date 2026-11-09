/**
 * ttl.sh's redactor is the shared one (`@hobo/core/provider-redaction`) plus
 * `Basic` credentials and long opaque runs, with digests kept whole. Before the
 * move it had its own copy, whose JWT and private-key shapes backtracked
 * (every `ey` and every BEGIN started a search to the end) and whose opaque-run
 * shape could start at every word boundary inside a run. These pin that
 * nothing it redacted leaks now, that digests still survive, and that the
 * shapes are linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { containsControlChar, redactProviderText } from "../src/errors.js";

const MB = 1_000_000;
const digest = `sha256:${"0123456789abcdef".repeat(4)}`;

describe("provider-ttl-sh redaction", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"Bearer abc123",
			"Basic dXNlcjpwYXNz",
			"password=hunter2",
			"token: abc",
			"auth=abc",
			"ghp_abcdefghijkl",
			"glpat-abcdefghijkl",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig",
			"-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
			"-----BEGIN PRIVATE KEY----- and no end",
			"A".repeat(48),
		])
			expect(redactProviderText(`before ${secret} after`)).not.toMatch(
				/abc|hunter2|dXNl|MIIB|AAAA|eyJ/u,
			);
		expect(redactProviderText("oci://u:pw@ttl.sh/x")).not.toContain("pw");
	});

	it("keeps digests whole, and keeps a registry path", () => {
		expect(redactProviderText(`pushed ttl.sh/app@${digest} as ${digest}`)).toBe(
			`pushed ttl.sh/app@${digest} as ${digest}`,
		);
		expect(redactProviderText("ttl.sh/hobo-abc/app:1h")).toBe(
			"ttl.sh/hobo-abc/app:1h",
		);
	});

	it.each([
		["-ey", repeatedTo("-ey")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["an opaque run of word boundaries", repeatedTo("a+")],
		["digests", repeatedTo(`${digest} `)],
	] as const)("redacting %s grows linearly", (_case, input) => {
		assertGrowsLinearly((text) => {
			redactProviderText(text, 8 * MB);
		}, input);
	});

	it("still reports control characters", () => {
		expect(containsControlChar("a\u0007")).toBe(true);
		expect(containsControlChar("a")).toBe(false);
	});
});
