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
	] as const)("scanning an artifact of %s grows linearly", (_case, input) => {
		assertGrowsLinearly((text) => {
			try {
				assertSanitized(artifactNoting(text));
			} catch {
				// Refusing is fine; stalling is not.
			}
		}, input);
	});
});
