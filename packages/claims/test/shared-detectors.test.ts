/**
 * The event guard's JWT and private-key detectors are the shared ones
 * (`@hobo/provider-redaction`). Its own JWT detector started again at
 * every `ey` and scanned to the end of the run, and its claim-URL detector
 * scanned from every `http` to the end and back for each part: on a payload
 * holding a megabyte of `-ey` or of `http://claim?`, the guard stalled the
 * append. These pin that it still refuses what it refused, and is linear.
 */
import { assertPatternSweepLinear, ownPatterns } from "@hobo/provider-redaction/linear-sweep";
import { assertGrowsLinearly, repeatedTo } from "@hobo/provider-redaction/linear-time";
import {
	assertFindsNoLess,
	JWT_PIECES,
	PEM_PIECES,
	URL_PIECES,
} from "@hobo/provider-redaction/redaction-differential";
import { describe, expect, it } from "vitest";
import { FORBIDDEN_IN_EVENTS } from "../src/events.js";
import { assertNoSecrets, type ClaimEvent } from "../src/index.js";
import { assertNoSecrets as baseAssertNoSecrets } from "./fixtures/base-guard.js";

const observed = (observedStatus: string): ClaimEvent => ({
	type: "ClaimStatusObserved",
	itemId: "i",
	observedStatus,
});

describe("assertNoSecrets detectors", () => {
	it.each([
		["a jwt", "x eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig"],
		["a jwt after a hyphen", "x-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.sig"],
		["a private key", "-----BEGIN RSA PRIVATE KEY-----"],
		["a claim url", "see https://vercel.com/claim/transfer?code=abc"],
	])("still refuses %s", (_case, status) => {
		expect(() => assertNoSecrets(observed(status))).toThrow(
			/refusing to append/u,
		);
	});

	it("does not refuse a claim url with no credential parameter", () => {
		expect(() =>
			assertNoSecrets(observed("see https://example.com/claim?page=2")),
		).not.toThrow();
	});

	it.each([
		["-ey", repeatedTo("-ey")],
		["http://claim?", repeatedTo("http://claim?")],
		["http://", repeatedTo("http://")],
	] as const)(
		"checking a payload of %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly(
				(text) => {
					try {
						assertNoSecrets(observed(text));
					} catch {
						// Refusing is fine; stalling is not.
					}
				},
				input,
				// The old claim-URL detector was worse than quadratic: one call on 16
				// kB took minutes. Starting at 1 kB, it fails the measure in seconds.
				{ startLength: 1024 },
			);
		},
	);
});

// Against the guard as it stood before (vendored under test/fixtures): on
// 150k generated texts per piece set, it refuses every event the old one did.

describe("assertNoSecrets against the guard it replaced", () => {
	const refuses = (check: (event: ClaimEvent) => void) => (text: string) => {
		try {
			check(observed(text));
			return false;
		} catch {
			return true;
		}
	};
	it.each([
		["claim urls", URL_PIECES],
		["jwts", JWT_PIECES],
		["private keys", PEM_PIECES],
	] as const)(
		"refuses every event the old guard refused, on %s",
		{ timeout: 60_000 },
		(_case, pieces) => {
			expect(
				assertFindsNoLess(
					refuses(baseAssertNoSecrets),
					refuses(assertNoSecrets),
					pieces,
				),
			).toBeGreaterThan(1000);
		},
	);
});

// Each of the event guard's patterns, on runs of every class and between its own
// fragments (`patternFragments`), but those core shares, which core sweeps.
describe("each pattern on the whole sweep", () => {
	it.each(
		ownPatterns(FORBIDDEN_IN_EVENTS.map((entry) => entry.pattern)).map(
			(pattern) => [pattern.source, pattern] as const,
		),
	)("/%s/ grows linearly", { timeout: 60_000 }, (_source, pattern) => {
		assertPatternSweepLinear(pattern);
	});
});
