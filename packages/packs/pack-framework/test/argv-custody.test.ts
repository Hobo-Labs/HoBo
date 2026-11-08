import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
	assertArgvSafe,
	assertArgvValue,
	depositSecret,
	generateSecret,
	PackError,
	type PackSecretCustodyPort,
	type PackSecretScope,
} from "../src/index.js";
import type { JsonValue } from "../src/json.js";

const SCOPE: PackSecretScope = {
	packId: "pack.example.oci/v1",
	resourceRef: "camp-demo/cache-main",
	purpose: "cache-auth-password",
};

const POLICY = { minimumLength: 32, alphabet: "base64url" } as const;

describe("assertArgvSafe", () => {
	it("passes an ordinary argv through unchanged", () => {
		const argv = ["/usr/bin/pg_dump", "--format=custom", "--dbname", "appdb"];
		assert.deepEqual(assertArgvSafe(argv), argv);
	});

	it("keeps a shell metacharacter inert instead of rejecting it", () => {
		// There is no shell, so this is one argument that happens to be ugly.
		// Rejecting it would push callers toward quoting, which is the actual bug.
		const argv = ["/usr/bin/pg_dump", "--dbname", "x; rm -rf /"];
		assert.deepEqual(assertArgvSafe(argv), argv);
	});

	it("refuses an empty argv", () => {
		assert.throws(() => assertArgvSafe([]), PackError);
	});

	it("refuses a NUL, which would silently truncate the argument", () => {
		assert.throws(
			() => assertArgvSafe(["/usr/bin/pg_dump", "app\u0000db"]),
			PackError,
		);
	});

	it("refuses a newline, which forges log lines downstream", () => {
		assert.throws(
			() => assertArgvSafe(["/usr/bin/pg_dump", "app\ndb"]),
			PackError,
		);
	});

	for (const credential of [
		"postgresql://app:hunter2@db.internal:5432/appdb",
		"redis://:hunter2@cache.internal:6379",
		"--password=hunter2",
		"-----BEGIN OPENSSH PRIVATE KEY-----",
	]) {
		it(`refuses credential-shaped material in argv: ${credential.slice(0, 24)}…`, () => {
			// argv is world-readable through `ps`; a credential belongs in the
			// environment, on stdin, or behind a file descriptor.
			assert.throws(
				() => assertArgvSafe(["/usr/bin/psql", credential]),
				PackError,
			);
		});
	}

	it("rejects an over-long element", () => {
		assert.throws(
			() => assertArgvValue("x".repeat(1025), "argv element"),
			PackError,
		);
	});
});

describe("pack secret custody", () => {
	it("returns only a locator when custody mints the credential", async () => {
		const custody: PackSecretCustodyPort = {
			generate: () =>
				Promise.resolve("hobo-secret://tenant-demo/cache-main/auth"),
			deposit: () => Promise.reject(new Error("not used")),
		};
		const ref = await generateSecret(custody, SCOPE, POLICY);
		assert.equal(ref.ref, "hobo-secret://tenant-demo/cache-main/auth");
		assert.equal(ref.scheme, "hobo-secret");
	});

	it("rejects a custody implementation that hands back the value itself", async () => {
		const custody: PackSecretCustodyPort = {
			generate: () => Promise.resolve("redis://:hunter2@cache.internal:6379"),
			deposit: () => Promise.reject(new Error("not used")),
		};
		await assert.rejects(
			generateSecret(custody, SCOPE, POLICY),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "SECRET_CUSTODY_UNAVAILABLE");
				// The offending value must not survive into the error text.
				assert.ok(!error.message.includes("hunter2"));
				return true;
			},
		);
	});

	it("refuses a weak generation policy before custody is even called", async () => {
		let called = false;
		const custody: PackSecretCustodyPort = {
			generate: () => {
				called = true;
				return Promise.resolve("hobo-secret://tenant-demo/cache-main/auth");
			},
			deposit: () => Promise.reject(new Error("not used")),
		};
		await assert.rejects(
			generateSecret(custody, SCOPE, { minimumLength: 8, alphabet: "hex" }),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "PACK_CONFIGURATION_INVALID");
				return true;
			},
		);
		assert.equal(called, false);
	});

	it("reports an unavailable custody as SECRET_CUSTODY_UNAVAILABLE, not as a generic failure", async () => {
		const custody: PackSecretCustodyPort = {
			generate: () => Promise.reject(new Error("vault sealed")),
			deposit: () => Promise.reject(new Error("vault sealed")),
		};
		await assert.rejects(
			generateSecret(custody, SCOPE, POLICY),
			(error: JsonValue) => {
				assert.ok(error instanceof PackError);
				assert.equal(error.code, "SECRET_CUSTODY_UNAVAILABLE");
				return true;
			},
		);
	});

	it("deposits externally produced material and keeps it out of the returned locator", async () => {
		const seen: string[] = [];
		const custody: PackSecretCustodyPort = {
			generate: () => Promise.reject(new Error("not used")),
			deposit: (value) => {
				seen.push(value);
				return Promise.resolve("hobo-secret://tenant-demo/backup/credential");
			},
		};
		const ref = await depositSecret(custody, "imported-material", {
			...SCOPE,
			purpose: "backup-credential",
		});
		assert.deepEqual(seen, ["imported-material"]);
		assert.ok(!String(ref.ref).includes("imported-material"));
	});
});
