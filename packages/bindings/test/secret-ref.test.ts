import { describe, expect, it } from "vitest";

import {
	parseSecretRef,
	redactSecretRef,
	type SecretRefError,
	SecretValue,
} from "../src/index.js";

describe("secret reference parsing", () => {
	it.each([
		"vault://tenant/database/primary#password",
		"azure-kv://vault/secret/version",
		"aws-sm://us-east-1/hobo-lease-42",
		"gcp-sm://project/secret/version",
		"op://vault/item#credential",
		"infisical://project/prod/api/key",
		"hobo-token://lease/01JABCDE",
	])("accepts %s", (input) => {
		expect(parseSecretRef(input).ref).toBe(input);
	});

	it("rejects an unregistered scheme", () => {
		expect(() => parseSecretRef("ftp://host/secret")).toThrow(
			/scheme "ftp" is not registered/u,
		);
	});

	it("rejects embedded userinfo", () => {
		expect(() => parseSecretRef("vault://user:pass@tenant/path")).toThrow(
			/must not embed userinfo/u,
		);
	});

	it("rejects path traversal", () => {
		expect(() => parseSecretRef("vault://tenant/../other/secret")).toThrow(
			/path traversal/u,
		);
	});

	it("rejects a query string", () => {
		expect(() => parseSecretRef("vault://tenant/path?token=abc")).toThrow(
			/query string/u,
		);
	});

	it("rejects control characters used for log forging", () => {
		expect(() => parseSecretRef("vault://tenant/path\n2026 INFO fake")).toThrow(
			/control characters/u,
		);
	});

	it("rejects a fragment on a scheme that does not define one", () => {
		expect(() => parseSecretRef("aws-sm://us-east-1/secret#field")).toThrow(
			/does not define a fragment selector/u,
		);
	});

	it("requires an authority and at least one path segment", () => {
		expect(() => parseSecretRef("vault://tenant")).toThrow(
			/at least one path segment/u,
		);
	});

	it("rejects uppercase schemes rather than silently normalizing", () => {
		expect(() => parseSecretRef("VAULT://tenant/path")).toThrow(/lowercase/u);
	});

	it.each([
		[
			"postgresql://user:pw@db.example.com:5432/app",
			"a postgres connection string",
		],
		["redis://default:token@fly-redis:6379", "a redis url"],
		["Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "a bearer token"],
		["-----BEGIN RSA PRIVATE KEY-----", "a private key"],
		["sk_live_51H8xQ2abcdefghijklmnop", "an api key"],
	])("rejects %s as a plaintext credential (%s)", (input) => {
		const error = (() => {
			try {
				parseSecretRef(input);
				return undefined;
			} catch (caught) {
				// SAFETY: parseSecretRef throws SecretRefError for this table's inputs.
				return caught as SecretRefError;
			}
		})();
		expect(error?.code).toBe("SECRET_REFERENCE_EMBEDS_VALUE");
		// The rejected input must never be echoed back into the error message.
		expect(error?.message).not.toContain(input);
	});
});

describe("redaction", () => {
	it("elides everything past the first path segment", () => {
		expect(
			redactSecretRef("vault://acme-tenant/db/primary/password#value"),
		).toBe("vault://acme-tenant/db/…#…");
	});

	it("redacts an unparseable input rather than echoing it", () => {
		expect(redactSecretRef("postgresql://user:pw@host/db")).toBe(
			"<redacted-secret-ref>",
		);
	});
});

describe("SecretValue", () => {
	const ref = parseSecretRef("vault://tenant/db/primary#password");
	const secret = new SecretValue(ref, "s3cr3t-connection-string");

	it("exposes the value only through expose()", () => {
		expect(secret.expose()).toBe("s3cr3t-connection-string");
	});

	it("never serializes the value", () => {
		expect(JSON.stringify({ credential: secret })).not.toContain("s3cr3t");
		expect(`${secret}`).not.toContain("s3cr3t");
		expect(String(secret)).toBe("vault://tenant/db/…#…");
	});

	it("does not leak through string interpolation into a command line", () => {
		const command = `psql ${secret}`;
		expect(command).not.toContain("s3cr3t");
	});

	it("reports the reference it came from", () => {
		expect(secret.ref).toBe("vault://tenant/db/primary#password");
	});
});
