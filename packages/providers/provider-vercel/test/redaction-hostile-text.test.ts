/**
 * redactProviderText on a hostile text: it stays linear, it searches only the
 * first REDACTION_WINDOW characters, and a credential the window cuts through
 * leaves nothing behind.
 *
 * The Vercel deploy's refusal path hands it a whole response body, and a body
 * is whatever the other end sent. Two shapes were once quadratic in it: the JWT
 * shape could start at every `ey` and run to the end (100 kB of `-ey` took
 * about ten seconds), and the private-key shape searched from every BEGIN for
 * an END that never came.
 */
import { describe, expect, it } from "vitest";

import {
	REDACTION_WINDOW,
	redactProviderText,
} from "../src/provider-errors.js";

describe("redactProviderText on a hostile text", () => {
	// A hostile body must not stall the error path: every shape is linear in
	// the text, and only the first REDACTION_WINDOW characters are searched.
	const MB = 1_000_000;
	const repeated = (unit: string, length = MB) =>
		unit.repeat(Math.ceil(length / unit.length));

	it.each([
		// Each `ey` once started a JWT search that ran to the end of the text.
		["-ey, over and over", repeated("-ey")],
		// Each BEGIN once started a search for an END that never comes.
		["BEGIN markers, over and over", repeated("-----BEGIN PRIVATE KEY-----")],
		[
			"a mix of both, near-miss JWTs, bearer and key shapes, and whitespace",
			repeated(
				"-ey-ey eyAAAAAAAAAAAA.eyBBBBBBBBBBBB -----BEGIN RSA PRIVATE KEY-----\n-----BEGIN PRIVATE KEY----- Bearer api_key= code= sk- \t\r\n",
			),
		],
	])("stays linear on 1 MB of %s", (_case, hostile) => {
		const started = performance.now();
		const redacted = redactProviderText(hostile);
		const took = performance.now() - started;

		expect(hostile.length).toBeGreaterThanOrEqual(MB);
		expect(redacted.length).toBeLessThanOrEqual(257);
		expect(took).toBeLessThan(250);
	});

	// The shapes themselves, with the window opened past the whole megabyte (it
	// is four times maxLength): linear without the window's help.
	it.each([
		["-ey, over and over", repeated("-ey")],
		["BEGIN markers, over and over", repeated("-----BEGIN PRIVATE KEY-----")],
		[
			"a mix of both, and whitespace",
			repeated("-ey-ey eyAAAAAAAAAAAA. -----BEGIN PRIVATE KEY-----\n "),
		],
	])("searches 1 MB of %s whole in linear time", (_case, hostile) => {
		const started = performance.now();
		const redacted = redactProviderText(hostile, 2 * MB);
		const took = performance.now() - started;

		expect(hostile.length).toBeLessThan(2 * MB);
		expect(redacted.endsWith("…")).toBe(false);
		expect(took).toBeLessThan(1000);
	});

	// Text the shapes shrink to almost nothing (a bearer token of 400
	// characters is ten once redacted), so the window's end reaches the output.
	const shrinking = (before: number) =>
		repeated(`Bearer ${"A".repeat(400)} `, before).slice(
			0,
			before - (before % 408),
		);

	it("leaves nothing of a private key the window cuts, BEGIN kept and END cut off", () => {
		const body = Array.from(
			{ length: 40 },
			(_, i) => `MIIK${String(i).padStart(4, "0")}${"q".repeat(56)}`,
		).join("\n");
		const text = `${shrinking(REDACTION_WINDOW - 100)}-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;

		const redacted = redactProviderText(text);

		expect(text.indexOf("-----BEGIN")).toBeLessThan(REDACTION_WINDOW);
		expect(text.indexOf("-----END")).toBeGreaterThan(REDACTION_WINDOW);
		expect(redacted).not.toContain("MIIK");
		expect(redacted).not.toContain("qqqq");
		expect(redacted).not.toContain("BEGIN");
		expect(redacted.endsWith("[redacted]…")).toBe(true);
	});

	it("leaves nothing of a JWT the window cuts", () => {
		const header = `eyJ${"h".repeat(40)}`;
		const payload = `eyJ${"p".repeat(4000)}`;
		const text = `${shrinking(REDACTION_WINDOW - 100)}token ${header}.${payload}.sigsigsigsigsig`;

		const redacted = redactProviderText(text);

		expect(text.indexOf(header)).toBeLessThan(REDACTION_WINDOW);
		expect(text.indexOf(".sig")).toBeGreaterThan(REDACTION_WINDOW);
		expect(redacted).not.toContain("eyJ");
		expect(redacted).not.toContain("hhhh");
		expect(redacted).not.toContain("pppp");
		expect(redacted.endsWith("token…")).toBe(true);
	});

	it("redacts a private key whole across a foreign END marker inside it", () => {
		const redacted = redactProviderText(
			"key -----BEGIN PRIVATE KEY-----\npartOne\n-----END CERTIFICATE-----\npartTwo\n-----END PRIVATE KEY----- done",
		);

		expect(redacted).toBe("key [redacted] done");
	});

	it.each([
		["END markers", repeated("-----END CERTIFICATE-----\n")],
		[
			"END markers after a BEGIN",
			`-----BEGIN PRIVATE KEY-----\n${repeated("-----END CERT ")}`,
		],
		[
			"long END labels",
			`-----BEGIN PRIVATE KEY-----\n${repeated(`-----END ${"A ".repeat(500)}`)}`,
		],
	])("searches 1 MB of %s whole in linear time", (_case, hostile) => {
		const started = performance.now();
		redactProviderText(hostile, 2 * MB);
		const took = performance.now() - started;

		expect(took).toBeLessThan(1000);
	});

	it("redacts a private key whose END is missing to the end of the text", () => {
		const redacted = redactProviderText(
			"key -----BEGIN EC PRIVATE KEY-----\nMIIBOgIBAAJBAK and the rest",
		);

		expect(redacted).toBe("key [redacted]");
	});

	it("still redacts a JWT that follows a space, a quote, or an equals sign", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NX0.dBjftJeZ4CVPmB92K";
		for (const before of [" ", '"', "=", ":"]) {
			expect(redactProviderText(`x${before}${jwt}`)).toBe(
				`x${before}[redacted]`,
			);
		}
	});
});
