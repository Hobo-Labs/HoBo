/**
 * `redactClusterText` is the shared redactor (`@hobo/core/provider-redaction`)
 * plus the kubeconfig's embedded blobs and an imagePullSecret's
 * dockerconfigjson. Before the move it had its own copy, and three of its
 * shapes backtracked on an apiserver body: the JWT shape started again at
 * every `eyJ`, the private-key shape searched from every BEGIN for an END, and
 * the dockerconfigjson shape from every `"auths":{` for a `}`. These pin that
 * nothing it redacted leaks now and that it is linear.
 */
import { assertGrowsLinearly, repeatedTo } from "@hobo/core/linear-time";
import { describe, expect, it } from "vitest";

import { redactClusterText } from "../src/errors.js";

const MB = 1_000_000;

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
		// Before, the shape needed a `}` and left this whole.
		expect(
			redactClusterText('secret {"auths": {"r": {"auth": "dXNlcjpwYXNz"'),
		).toBe("secret {[redacted]");
	});

	it.each([
		["-eyJ", repeatedTo("-eyJ")],
		["BEGIN markers", repeatedTo("-----BEGIN PRIVATE KEY-----")],
		['"auths":{ with no closing brace', repeatedTo('"auths":{')],
	] as const)(
		"redacting %s grows linearly",
		{ timeout: 30_000 },
		(_case, input) => {
			assertGrowsLinearly((text) => {
				redactClusterText(text, 8 * MB);
			}, input);
		},
	);
});

// The same three secrets, redacted whole, by every caller of the shared
// redactor: a JWT with a long header and signature (a generic long-run rule
// searched first split one and left its payload), a private key, and a URL
// with credentials.
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
