import {
	assertFindsNoLess,
	DSN_PIECES,
	JWT_PIECES,
	PEM_PIECES,
} from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";
import { assertSanitized, LiveEvidenceError } from "../src/live/index.js";
import { assertSanitized as baseAssertSanitized } from "./fixtures/base-guard.js";

function artifactNoting(note: string): Parameters<typeof assertSanitized>[0] {
	// SAFETY: a fixture holding one string is the assertSanitized input at this test boundary.
	return {
		schema: "hobo.conformance.anonymous-trust-evidence/v1",
		evidence: { note },
	} as never;
}

describe("assertSanitized detectors", () => {
	it.each([
		["a jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.c2lnbmF0dXJlMTIz"],
		["a jwt after a hyphen", "x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.c2ln"],
		["a private key", "-----BEGIN PRIVATE KEY-----"],
		["a postgres url with credentials", "postgresql://app:hunter2@db/app"],
		["a redis url with credentials", "rediss://default:pw@cache:6379"],
		["a mongodb url with credentials", "mongodb+srv://u:p:x@cluster/db"],
		// Spellings `iu` matched: \u017F for s and \u212A for k.
		[
			"a postgres url spelled with \u017F",
			"po\u017Ftgres://app:hunter2@db/app",
		],
		["a redis url spelled with \u017F", "redi\u017F://default:pw@cache:6379"],
		[
			"a mongodb url spelled with \u017F",
			"mongodb+\u017Frv://u:p:x@cluster/db",
		],
	])("still refuses %s", (_case, note) => {
		expect(() => assertSanitized(artifactNoting(note))).toThrow(
			LiveEvidenceError,
		);
	});

	it("does not refuse a connection string with no credentials", () => {
		expect(() =>
			assertSanitized(artifactNoting("postgres://db.example/app")),
		).not.toThrow();
	});

	// The patterns before this branch, which the scan must still agree with.
	const OLD_CONNECTION_STRINGS = [
		/postgres(?:ql)?:\/\/[^\s"]*:[^\s"]*@/iu,
		/rediss?:\/\/[^\s"]*:[^\s"]*@/iu,
		/mysql:\/\/[^\s"]*:[^\s"]*@/iu,
		/mongodb(?:\+srv)?:\/\/[^\s"]*:[^\s"]*@/iu,
	];

	// A small deterministic generator, so a failure names a text that replays.
	function* notes(count: number) {
		const alphabet = [
			"postgres://",
			"postgresql://",
			"rediss://",
			"redis://",
			"mysql://",
			"mongodb+srv://",
			"a",
			":",
			"@",
			"/",
			" ",
			'"',
			"x:y@",
		];
		let seed = 20261109;
		for (let index = 0; index < count; index++) {
			let note = "";
			for (let unit = 0; unit < 1 + (index % 12); unit++) {
				seed = (seed * 1103515245 + 12345) % 2147483648;
				note += alphabet[seed % alphabet.length];
			}
			yield note;
		}
	}

	it("refuses a connection string exactly when the old patterns did", () => {
		const refuses = (note: string) => {
			try {
				assertSanitized(artifactNoting(note));
				return false;
			} catch (error) {
				if (error instanceof LiveEvidenceError) return true;
				throw error;
			}
		};
		for (const note of notes(20_000)) {
			// The artifact is serialized before it is scanned, so the old patterns
			// see the JSON the scan sees.
			const serialized = JSON.stringify(artifactNoting(note));
			expect(refuses(note), JSON.stringify(note)).toBe(
				OLD_CONNECTION_STRINGS.some((pattern) => pattern.test(serialized)),
			);
		}
	});
});

// Against the scan as it stood before (vendored under test/fixtures): on 150k
// generated texts per piece set, it refuses every artifact the old one did.

describe("assertSanitized against the scan it replaced", () => {
	const refuses =
		(check: (artifact: Parameters<typeof assertSanitized>[0]) => void) =>
		(text: string) => {
			try {
				check(artifactNoting(text));
				return false;
			} catch {
				return true;
			}
		};
	it.each([
		["connection strings", DSN_PIECES],
		["jwts", JWT_PIECES],
		["private keys", PEM_PIECES],
	] as const)("on 20k texts, refuses every artifact the old scan refused, on %s", (_case, pieces) => {
		expect(
			assertFindsNoLess(
				refuses(baseAssertSanitized),
				refuses(assertSanitized),
				pieces,
				20_000,
			),
		).toBeGreaterThan(100);
	});
});
