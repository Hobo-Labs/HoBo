/**
 * Splitting a Postgres URI into the part that is an address and the part that
 * is a credential.
 *
 * The whole URI is secret material — it carries a password — so this module's
 * job is to extract exactly the fields that are safe to publish on a receipt
 * and leave everything else behind. Three properties carry that weight.
 *
 * **Failures never quote the input.** The input *is* the credential, so an
 * error message echoing it would put a live password into a log line, a stack
 * trace, and an error-reporting service. Every refusal here describes the
 * problem without reproducing the string.
 *
 * **`password=` is dropped rather than republished.** A connection parameter
 * is not a credential today, but `password` and `passfile` are legal libpq
 * keywords — a provider that returned one in the query string would otherwise
 * have it copied straight onto a receipt.
 *
 * **`hasPassword` is a boolean, never the password.** Callers need to know
 * whether the URI is complete; nobody downstream needs the value.
 *
 * The host checks are strict for the same reason: a hostname carrying anything
 * but a plain DNS name is a provider contract change, and guessing what it
 * meant would connect somewhere nobody chose.
 */
import { describe, expect, it } from "vitest";

import {
	deriveDirectConnectionUri,
	isPooledHost,
	parsePostgresConnectionUri,
	toDirectHost,
} from "../src/connection-string.js";
import { NeonProviderError } from "../src/errors.js";

const URI = "postgresql://alice:s3cret@ep-cool-1-pooler.eu.aws.neon.tech/main";

/** The error a call throws, or undefined if it did not throw. */
function errorOf(run: () => unknown): NeonProviderError | undefined {
	try {
		run();
		return undefined;
	} catch (error) {
		expect(error).toBeInstanceOf(NeonProviderError);
		return error as NeonProviderError;
	}
}

describe("URI shape", () => {
	it("parses a complete pooled URI", () => {
		const parts = parsePostgresConnectionUri(URI);
		expect(parts.host).toBe("ep-cool-1-pooler.eu.aws.neon.tech");
		expect(parts.database).toBe("main");
		expect(parts.username).toBe("alice");
		expect(parts.hasPassword).toBe(true);
	});

	it("accepts both postgres and postgresql schemes", () => {
		// Both are in circulation; a provider returning the shorter form is not
		// a contract change.
		for (const scheme of ["postgres", "postgresql"]) {
			expect(
				parsePostgresConnectionUri(`${scheme}://a:b@db.example/main`).host,
			).toBe("db.example");
		}
	});

	it("refuses a scheme that is not postgres", () => {
		// A `mysql:` or `https:` URI here means the provider changed what it
		// returns, and connecting anyway would talk the wrong protocol.
		for (const value of ["mysql://a:b@db.example/main", "https://db.example"]) {
			expect(errorOf(() => parsePostgresConnectionUri(value))?.code).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});

	it("refuses a value that is not a URI at all", () => {
		for (const value of ["", "not a uri", "db.example/main"]) {
			expect(errorOf(() => parsePostgresConnectionUri(value))?.code).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});

	it("never quotes the input in any refusal", () => {
		// The input is the credential. An error echoing it would put a live
		// password into every log line and error report that carries the throw.
		const secret = "sup3r-s3cret-value";
		for (const value of [
			`mysql://alice:${secret}@db.example/main`,
			`postgres://alice:${secret}@db.example/`,
			`postgres://:${secret}@db.example/main`,
			`postgres://alice:${secret}@UPPER_CASE!/main`,
		]) {
			const error = errorOf(() => parsePostgresConnectionUri(value));
			expect(error?.message ?? "", value).not.toContain(secret);
			expect(error?.message ?? "").not.toContain("alice");
		}
	});
});

describe("host", () => {
	it("lowercases the hostname", () => {
		// Hostnames are case-insensitive, and a caller comparing them would
		// otherwise treat two spellings of one endpoint as different.
		expect(
			parsePostgresConnectionUri("postgres://a:b@DB.Example.COM/main").host,
		).toBe("db.example.com");
	});

	it("refuses a host that is not a plain DNS name", () => {
		// An IP literal, an underscore, or a trailing dot each mean the provider
		// returned something other than the endpoint contract promises — and
		// connecting anyway would reach somewhere nobody chose.
		for (const host of ["db_example", "[::1]", "-db.example", "db..example"]) {
			expect(
				errorOf(() => parsePostgresConnectionUri(`postgres://a:b@${host}/main`))
					?.code,
				host,
			).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("accepts a single-label host", () => {
		expect(
			parsePostgresConnectionUri("postgres://a:b@localhost/main").host,
		).toBe("localhost");
	});
});

describe("port", () => {
	it("defaults to the Postgres port when none is given", () => {
		// A missing port is the normal case, and `NaN` here would produce a
		// connect call that fails with an error about a number.
		expect(
			parsePostgresConnectionUri("postgres://a:b@db.example/main").port,
		).toBe(5432);
	});

	it("takes an explicit port as a number", () => {
		expect(
			parsePostgresConnectionUri("postgres://a:b@db.example:6543/main").port,
		).toBe(6543);
	});
});

describe("database name", () => {
	it("decodes a percent-encoded name", () => {
		// The name reaches a connect call. Leaving it encoded would open a
		// database literally named `my%20db`.
		expect(
			parsePostgresConnectionUri("postgres://a:b@db.example/my%20db").database,
		).toBe("my db");
	});

	it("refuses an empty database name", () => {
		// A URI with no path names no database, and defaulting to one would
		// connect to whichever database happens to share the role's name.
		for (const path of ["", "/"]) {
			expect(
				errorOf(() =>
					parsePostgresConnectionUri(`postgres://a:b@db.example${path}`),
				)?.code,
			).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("refuses a name carrying a control character", () => {
		// The name reaches an argv element and a log line. A newline or a NUL
		// there can truncate an argument or split a log record.
		for (const encoded of ["%00", "%0a", "db%09name"]) {
			expect(
				errorOf(() =>
					parsePostgresConnectionUri(`postgres://a:b@db.example/${encoded}`),
				)?.code,
				encoded,
			).toBe("PROVIDER_CONTRACT_CHANGED");
		}
	});

	it("refuses a name over the length bound", () => {
		// Postgres will not accept it either, and an unbounded name is a way to
		// push arbitrary bytes into every command line that carries it.
		expect(
			parsePostgresConnectionUri(`postgres://a:b@db.example/${"d".repeat(128)}`)
				.database,
		).toHaveLength(128);
		expect(
			errorOf(() =>
				parsePostgresConnectionUri(
					`postgres://a:b@db.example/${"d".repeat(129)}`,
				),
			)?.code,
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});
});

describe("username", () => {
	it("decodes a percent-encoded role name", () => {
		expect(
			parsePostgresConnectionUri("postgres://my%20role:b@db.example/main")
				.username,
		).toBe("my role");
	});

	it("refuses a URI with no role", () => {
		// Half a credential pair is not usable, and proceeding would connect as
		// whatever the client's OS user happens to be.
		expect(
			errorOf(() => parsePostgresConnectionUri("postgres://:b@db.example/main"))
				?.code,
		).toBe("PROVIDER_CONTRACT_CHANGED");
		expect(
			errorOf(() => parsePostgresConnectionUri("postgres://db.example/main"))
				?.code,
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});

	it("refuses a role name over the length bound", () => {
		expect(
			errorOf(() =>
				parsePostgresConnectionUri(
					`postgres://${"u".repeat(129)}:b@db.example/main`,
				),
			)?.code,
		).toBe("PROVIDER_CONTRACT_CHANGED");
	});
});

describe("password", () => {
	it("reports only whether one is present", () => {
		// Callers need to know the URI is complete; nobody downstream needs the
		// value, and carrying it would put it in every parsed record.
		expect(parsePostgresConnectionUri(URI).hasPassword).toBe(true);
		expect(
			parsePostgresConnectionUri("postgres://alice@db.example/main")
				.hasPassword,
		).toBe(false);
	});

	it("carries no field holding the password itself", () => {
		const parts = parsePostgresConnectionUri(URI) as Record<string, unknown>;
		expect(JSON.stringify(parts)).not.toContain("s3cret");
	});
});

describe("connection parameters", () => {
	it("keeps parameters with libpq-shaped keys", () => {
		expect(
			parsePostgresConnectionUri(
				"postgres://a:b@db.example/main?application_name=hobo&connect_timeout=5",
			).parameters,
		).toEqual({ application_name: "hobo", connect_timeout: "5" });
	});

	it("drops password and passfile rather than republishing them", () => {
		// Both are legal libpq keywords. A provider returning one in the query
		// string would otherwise have it copied straight onto a receipt.
		const parts = parsePostgresConnectionUri(
			"postgres://a:b@db.example/main?password=leaked&passfile=/tmp/pw&sslmode=require",
		);
		expect(parts.parameters).toEqual({ sslmode: "require" });
		expect(JSON.stringify(parts)).not.toContain("leaked");
	});

	it("drops a key that is not a libpq identifier", () => {
		// An unrecognised key is not a connection parameter, and copying it onto
		// a receipt would publish whatever the provider appended.
		expect(
			parsePostgresConnectionUri(
				"postgres://a:b@db.example/main?Bad-Key=1&1bad=2&ok=3",
			).parameters,
		).toEqual({ ok: "3" });
	});

	it("truncates a parameter value rather than carrying it whole", () => {
		// The values land on a receipt. An unbounded one is a way to push
		// arbitrary content into a published record.
		expect(
			parsePostgresConnectionUri(
				`postgres://a:b@db.example/main?options=${"x".repeat(200)}`,
			).parameters.options,
		).toHaveLength(128);
	});

	it("freezes the parameter map", () => {
		expect(Object.isFrozen(parsePostgresConnectionUri(URI).parameters)).toBe(
			true,
		);
	});
});

describe("TLS", () => {
	it("assumes TLS when no sslmode is given", () => {
		// Neon requires TLS, and defaulting to false would report a connection
		// as plaintext on a receipt when it is not — or worse, have a caller
		// downgrade to match.
		expect(parsePostgresConnectionUri(URI).tls).toBe(true);
	});

	it("reports no TLS only for the two modes that genuinely mean it", () => {
		// `allow` prefers plaintext and falls back to TLS; `disable` refuses it.
		// Everything else — prefer, require, verify-full — ends up encrypted.
		for (const sslmode of ["disable", "allow"]) {
			expect(
				parsePostgresConnectionUri(
					`postgres://a:b@db.example/main?sslmode=${sslmode}`,
				).tls,
				sslmode,
			).toBe(false);
		}
		for (const sslmode of ["prefer", "require", "verify-ca", "verify-full"]) {
			expect(
				parsePostgresConnectionUri(
					`postgres://a:b@db.example/main?sslmode=${sslmode}`,
				).tls,
				sslmode,
			).toBe(true);
		}
	});

	it("assumes TLS for an sslmode it does not recognise", () => {
		// An unknown mode is not a reason to claim the connection is plaintext.
		expect(
			parsePostgresConnectionUri("postgres://a:b@db.example/main?sslmode=nope")
				.tls,
		).toBe(true);
	});
});

describe("pooled and direct hosts", () => {
	it("recognises a pooled host by its first label", () => {
		expect(isPooledHost("ep-cool-1-pooler.eu.aws.neon.tech")).toBe(true);
		expect(isPooledHost("ep-cool-1.eu.aws.neon.tech")).toBe(false);
	});

	it("does not treat -pooler elsewhere in the name as pooled", () => {
		// Only the first label carries Neon's pooling marker. A domain that
		// happens to contain the word is a different endpoint entirely.
		expect(isPooledHost("ep-cool-1.pooler.example.com")).toBe(false);
	});

	it("drops -pooler from the first label only", () => {
		// Applied to the whole string, a literal `-pooler` later in the name —
		// or in the credential of a full URI — would be rewritten too.
		expect(toDirectHost("ep-cool-1-pooler.eu.aws.neon.tech")).toBe(
			"ep-cool-1.eu.aws.neon.tech",
		);
		expect(toDirectHost("ep-pooler-1-pooler.a-pooler.example")).toBe(
			"ep-pooler-1.a-pooler.example",
		);
	});

	it("leaves a host that is already direct alone", () => {
		expect(toDirectHost("ep-cool-1.eu.aws.neon.tech")).toBe(
			"ep-cool-1.eu.aws.neon.tech",
		);
	});

	it("handles a single-label host", () => {
		expect(toDirectHost("localhost")).toBe("localhost");
		expect(toDirectHost("db-pooler")).toBe("db");
	});
});

describe("deriveDirectConnectionUri", () => {
	it("rewrites only the host, keeping the credential intact", () => {
		// The result is secret material the caller deposits. Losing the password
		// would produce a URI that fails to connect at the far end of a deposit.
		const direct = deriveDirectConnectionUri(URI);
		expect(direct).toContain("ep-cool-1.eu.aws.neon.tech");
		expect(direct).not.toContain("-pooler.");
		expect(direct).toContain("alice");
		expect(direct).toContain("s3cret");
	});

	it("returns nothing when the URI is already direct", () => {
		// `undefined` is how a caller knows there is no second URI to deposit —
		// returning the same string would have it stored twice under two names.
		expect(
			deriveDirectConnectionUri("postgres://a:b@ep-cool-1.eu.neon.tech/main"),
		).toBeUndefined();
	});

	it("returns nothing rather than throwing on an unparseable URI", () => {
		// This runs while assembling a deposit. An exception would abort the
		// whole provisioning over an optional second connection string.
		for (const value of ["", "not a uri", "db.example/main"]) {
			expect(deriveDirectConnectionUri(value)).toBeUndefined();
		}
	});

	it("keeps the port, path, and query", () => {
		const direct = deriveDirectConnectionUri(
			"postgres://a:b@ep-1-pooler.neon.tech:6543/main?sslmode=require",
		);
		expect(direct).toContain(":6543");
		expect(direct).toContain("/main");
		expect(direct).toContain("sslmode=require");
	});
});
