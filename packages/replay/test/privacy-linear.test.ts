/**
 * The debug-payload redactor tests every string against SECRET_STRING, and
 * three of its alternatives backtracked on a long one: the JWT alternative
 * started again at every `eyJ`, the credential-URL one at every letter, and
 * the key-assignment one at every place a key name could end, each reading to
 * the end of the run. Each now starts once per run. These pin, against the old
 * pattern on generated strings, that it accepts exactly the same strings, and
 * that its cost grows linearly.
 *
 * This is the fast tier: `privacy-linear.deep.test.ts` holds the sweeps, the
 * growth measurements and the full-size differential (`pnpm run test:deep`).
 */

import { KEPT_LOCATOR } from "@hobo/provider-redaction";
import { assertRevealsNoMore } from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import { redactDebugPayload } from "../src/index.js";
import { redactDebugPayload as baseRedactDebugPayload } from "./fixtures/base-redaction.js";

const OLD_SECRET_STRING =
	/(?:Bearer\s+\S+|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/:@]+:[^@\s/]+@|\b[A-Z][A-Z0-9_]*(?:PASSWORD|PASSWD|TOKEN|SECRET|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*\s*=)/i;

const MASK = "••••";
const masked = (value: string): boolean =>
	redactDebugPayload({ value }).value === MASK;

// A small deterministic generator, so a failure names a string that replays.
function* strings(alphabet: readonly string[], count: number) {
	let seed = 20261109;
	for (let index = 0; index < count; index++) {
		let text = "";
		const length = 1 + (index % 30);
		for (let char = 0; char < length; char++) {
			seed = (seed * 1103515245 + 12345) % 2147483648;
			text += alphabet[seed % alphabet.length];
		}
		yield text;
	}
}

describe("the debug-payload secret pattern", () => {
	it.each([
		["jwt", ["eyJ", "EYJ", "abcde", "-", "_", ".", " ", "x", "eyJabcde."]],
		[
			"credential url",
			["a", "Z", "1", "+", ".", "-", "://", ":", "/", "@", " ", "u:p@"],
		],
		[
			"key assignment",
			["A", "z", "9", "_", "PASSWORD", "TOKEN", "SECRET", "=", " ", "-"],
		],
	] as const)("accepts exactly what the old one did: %s", (_case, alphabet) => {
		for (const text of strings(alphabet, 20_000)) {
			expect(masked(text), JSON.stringify(text)).toBe(
				OLD_SECRET_STRING.test(text),
			);
		}
	});

	it("still masks the secrets it masked", () => {
		for (const secret of [
			"token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature-value",
			"postgres://app:supersecret@localhost/replay",
			"DB_PASSWORD=hunter2",
		])
			expect(masked(secret)).toBe(true);
		expect(masked("PASSWORD=x")).toBe(false);
	});
});

// Against the masking as it stood before (vendored under test/fixtures): on
// generated texts full of credential shapes and control characters, every
// string the old one masked is masked; and the check is linear on runs of
// every character class and pair of them.
describe("redactDebugPayload against the masking it replaced", () => {
	const shown =
		(redact: typeof redactDebugPayload) =>
		(text: string): string =>
			JSON.stringify(redact({ message: text }));
	it("on 5k texts, masks every string the old masking masked", () => {
		expect(
			assertRevealsNoMore(
				shown(baseRedactDebugPayload),
				shown(redactDebugPayload),
				{ count: 5_000, kept: KEPT_LOCATOR },
			),
		).toBeGreaterThan(500);
	});
});
