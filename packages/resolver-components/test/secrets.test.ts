import { describe, expect, it } from "vitest";
import { createSecretScanner, REDACTED } from "../src/index.js";

const SECRET = "s3cr3t-T0ken-value-42";

describe("secret scanner", () => {
	const scanner = createSecretScanner([`Bearer ${SECRET}`]);

	it.each([
		["raw", `prefix ${SECRET} suffix`],
		["the full header value", `Bearer ${SECRET}`],
		["base64", Buffer.from(SECRET).toString("base64")],
		["base64 inside a larger blob", Buffer.from(`xx${SECRET}yy`).toString("base64")],
		["base64url", Buffer.from(`a${SECRET}`).toString("base64url")],
		["hex", Buffer.from(SECRET).toString("hex")],
		["upper hex", Buffer.from(SECRET).toString("hex").toUpperCase()],
		["percent-encoded", encodeURIComponent(`${SECRET}/`)],
		["reversed", [...SECRET].reverse().join("")],
	])("finds the credential encoded as %s", (_label, text) => {
		expect(scanner.find(text)).toBe(true);
	});

	it("does not flag unrelated text", () => {
		expect(scanner.find("the deploy converged in 12 ms")).toBe(false);
		expect(scanner.find("Authorization: Bearer <redacted>")).toBe(false);
	});

	it("redacts every occurrence", () => {
		const redacted = scanner.redact(`{"auth":"Bearer ${SECRET}","again":"${SECRET}"}`);
		expect(redacted).not.toContain(SECRET);
		expect(redacted).toContain(REDACTED);
	});

	it("an empty scanner finds nothing", () => {
		expect(createSecretScanner([]).find(SECRET)).toBe(false);
	});
});
