import { KEPT_LOCATOR } from "@hobo/provider-redaction";
import { assertRevealsNoMore } from "@hobo/redaction-test-harness/redaction-differential";
import { describe, expect, it } from "vitest";

import { redactClusterText } from "../src/errors.js";
import { redactClusterText as baseRedact } from "./fixtures/base-redaction.js";

describe("redactClusterText", () => {
	it("still redacts every shape its own copy did", () => {
		for (const secret of [
			"Bearer abc123",
			"eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJrdWJlcm5ldGVzIn0.c2lnbmF0dXJl",
			"client-key-data: LS0tLS1CRUdJTg==",
			"client-certificate-data: LS0tLS1CRUdJTg==",
			"certificate-authority-data: LS0tLS1CRUdJTg==",
			"token: abc123",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
			'"auths": {"registry.example.com": {"auth": "dXNlcjpwYXNz"}}',
		])
			expect(redactClusterText(`before ${secret} after`)).not.toMatch(
				/abc123|eyJ|LS0t|MIIB|dXNl/u,
			);
	});

	it("now also redacts a dockerconfigjson whose closing brace was cut off", () => {
		expect(
			redactClusterText('secret {"auths": {"r": {"auth": "dXNlcjpwYXNz"'),
		).toBe("secret {[redacted]");
	});
});

describe("the shared shapes, through this caller", () => {
	const header = `eyJ${"h".repeat(53)}`;
	const payload = "eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJyb290In0";
	const signature = "s".repeat(48);
	it.each([
		["a JWT", `${header}.${payload}.${signature}`],
		[
			"a private key",
			"-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----",
		],
		["a URL with credentials", "https://admin:hunter2@db.example.com/app"],
	])("redacts %s whole", (_case, secret) => {
		const text = `before ${secret} after`;
		expect(redactClusterText(text)).toBe("before [redacted] after");
	});
});

describe("against the redactor it replaced", () => {
	const LONG = 1_000_000;
	it("on 5k texts, hides every marker the base branch's redactor hid", () => {
		const hidden = assertRevealsNoMore(
			(text) => baseRedact(text, LONG),
			(text) => redactClusterText(text, LONG),
			{ count: 5_000, kept: KEPT_LOCATOR },
		);
		expect(hidden).toBeGreaterThan(500);
	});
	it.each([
		["Bearer abcd\u0007SECRCTL3 ok", "SECRCTL3"],
		["token=abcd\u0000SECRCTL2tail", "SECRCTL2"],
	])("reads a credential on through a control character: %j", (text, marker) => {
		expect(redactClusterText(text, LONG)).not.toContain(marker);
	});
});
