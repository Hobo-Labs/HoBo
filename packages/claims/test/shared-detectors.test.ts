/**
 * The event guard's JWT and private-key detectors are the shared ones
 * (`@hobo/core/provider-redaction`). Its own JWT detector started again at
 * every `ey` and scanned to the end of the run, and its claim-URL detector
 * scanned from every `http` to the end and back for each part: on a payload
 * holding a megabyte of `-ey` or of `http://claim?`, the guard stalled the
 * append. These pin that it still refuses what it refused, and is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { assertNoSecrets, type ClaimEvent } from "../src/index.js";

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
