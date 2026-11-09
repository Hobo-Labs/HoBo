/**
 * The evidence scan's JWT and private-key detectors are the shared ones
 * (`@hobo/core/provider-redaction`). Its own JWT detector started again at
 * every `ey` and scanned to the end of the run, and its connection-string
 * detectors backtracked over every `:` for an `@`, so an artifact holding a
 * megabyte of `-ey` or of `postgres://:::` stalled the scan. These pin that it
 * still refuses what it refused, and is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { assertSanitized, LiveEvidenceError } from "../src/live/index.js";

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

	it.each([
		["-ey", repeatedTo("-ey")],
		[
			"postgres:// and colons",
			(length: number) => `postgres://${":".repeat(length)}`,
		],
		["postgres://a: with no @", repeatedTo("postgres://a:")],
		["postgres:// over and over", repeatedTo("postgres://")],
		["redis:// over and over", repeatedTo("redis://")],
		["mysql://a: with no @", repeatedTo("mysql://a:")],
		["mongodb+srv://a: with no @", repeatedTo("mongodb+srv://a:")],
		["-sk- over and over", repeatedTo("-sk-")],
		["Bearer and spaces", repeatedTo("Bearer ")],
	] as const)(
		"scanning an artifact of %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				try {
					assertSanitized(artifactNoting(text));
				} catch {
					// Refusing is fine; stalling is not.
				}
			}, input);
		},
	);

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
