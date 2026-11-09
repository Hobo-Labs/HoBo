/**
 * Prisma Postgres's redactor is the shared one (`@hobo/core/provider-redaction`) plus its
 * own shapes, with the text percent-decoded fully first. Before the move it
 * had its own copy, which decoded by running over the whole text again until
 * it stopped changing — one pass per layer of `%25`, so a megabyte of nested
 * encoding was quadratic — and whose private-key shape searched from every
 * BEGIN for an END. These pin that nothing it redacted leaks now, encoded or
 * not, and that it is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { containsControlChar, redactProviderText } from "../src/errors.js";

const MB = 1_000_000;

describe("provider-prisma-postgres redaction", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"Bearer abc123",
			"password=hunter2",
			"-----BEGIN PRIVATE KEY-----\\nMIIB\\n-----END PRIVATE KEY-----",
			"0b2f8a4e-1c3d-4e5f-8a9b-0c1d2e3f4a5b",
			"https://create-db.prisma.io/claim?projectID=proj_abc",
			"proj_abcdef",
			"postgres://u:p@db.prisma.io:5432/postgres",
			"prisma+postgres://accelerate.prisma-data.net/?api_key=abc",
			"api_key=abc",
		]) {
			// Its own copy left `prisma+` in front of a redacted Prisma Postgres
			// URL; the shared one takes the whole URL. Neither leaks the secret.
			const encoded = encodeURIComponent(encodeURIComponent(secret));
			for (const text of [secret, encoded]) {
				const redacted = redactProviderText(`before ${text} after`);
				expect(redacted).toMatch(/^before \S*\[redacted\] after$/u);
				expect(redacted).not.toContain(secret.slice(-6));
			}
		}
	});

	it.each([
		["nested %25", (length: number) => `%${"25".repeat(length / 2)}41`],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		["-ey", repeatedTo("-ey")],
	] as const)("redacting %s grows linearly", (_case, input) => {
		assertGrowsLinearly((text) => {
			redactProviderText(text, 8 * MB);
		}, input);
	});

	it("still reports control characters", () => {
		expect(containsControlChar("a\u001b[31m")).toBe(true);
		expect(containsControlChar("plain")).toBe(false);
	});
});
