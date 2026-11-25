import { describe, expect, it } from "vitest";
import {
	AUTH_ADAPTER_CONTRACT,
	BETTER_AUTH_ADAPTER_ID,
	BETTER_AUTH_SECRET_REF_SCHEMES,
	BetterAuthConfigError,
	betterAuthSecretRefScheme,
	parseBetterAuthConfig,
	parseBetterAuthSecretRef,
} from "../src/index.js";
import { isJsonObject, type JsonObject, type JsonValue } from "../src/json.js";

interface ConfigOverrides {
	readonly [key: string]: JsonValue | undefined;
}

function syntheticPemLikeSecretRef(): string {
	const begin = [
		"-",
		"B",
		"E",
		"G",
		"I",
		"N",
		" ",
		"P",
		"R",
		"I",
		"V",
		"A",
		"T",
		"E",
		" ",
		"K",
		"E",
		"Y",
		"-",
	];
	const end = [
		"-",
		"E",
		"N",
		"D",
		" ",
		"P",
		"R",
		"I",
		"V",
		"A",
		"T",
		"E",
		" ",
		"K",
		"E",
		"Y",
		"-",
	];
	return `${begin.join("")}${crypto.randomUUID().replaceAll("-", "")}${end.join("")}`;
}

function config(overrides: ConfigOverrides = {}): JsonObject {
	return {
		basePath: "/api/auth",
		secretRef: "hobo-secret://camp-prod/auth/better-auth-signing-key",
		database: { profile: "data.relational/v1" },
		...overrides,
	};
}

function codeOf(run: () => void): string {
	try {
		run();
	} catch (error) {
		if (error instanceof BetterAuthConfigError) return error.code;
		return `unexpected:${String(error)}`;
	}
	return "no-throw";
}

describe("parseBetterAuthConfig", () => {
	it("returns a frozen, defaulted, version-stamped record for a valid config", () => {
		const parsed = parseBetterAuthConfig(config());

		expect(parsed).toEqual({
			contract: AUTH_ADAPTER_CONTRACT,
			adapterId: BETTER_AUTH_ADAPTER_ID,
			basePath: "/api/auth",
			secretRef: "hobo-secret://camp-prod/auth/better-auth-signing-key",
			database: { profile: "data.relational/v1" },
			emailAndPassword: { enabled: true },
			socialProviders: [],
			organizations: { enabled: false },
		});
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.socialProviders)).toBe(true);
		expect(Object.isFrozen(parsed.database)).toBe(true);
	});

	it("accepts every registered locator scheme", () => {
		for (const scheme of BETTER_AUTH_SECRET_REF_SCHEMES) {
			const parsed = parseBetterAuthConfig(
				config({ secretRef: `${scheme}://authority/auth/signing-key` }),
			);
			expect(betterAuthSecretRefScheme(parsed.secretRef)).toBe(scheme);
		}
	});

	it("dedupes and sorts socialProviders so authoring order never leaks", () => {
		const parsed = parseBetterAuthConfig(
			config({ socialProviders: ["google", "github", "google"] }),
		);
		expect(parsed.socialProviders).toEqual(["github", "google"]);
	});

	it("is deterministic: the same input parses to a deep-equal record", () => {
		expect(parseBetterAuthConfig(config())).toEqual(
			parseBetterAuthConfig(config()),
		);
	});

	it("carries actionable remediation text on a refusal", () => {
		expect(() =>
			parseBetterAuthConfig(config({ secretRef: "hunter2-signing-key" })),
		).toThrow(BetterAuthConfigError);
		try {
			parseBetterAuthConfig(config({ secretRef: "hunter2-signing-key" }));
		} catch (error) {
			// SAFETY: assertion to `error as BetterAuthConfigError` is required at this boundary.
			const refusal = error as BetterAuthConfigError;
			expect(refusal.name).toBe("BetterAuthConfigError");
			expect(refusal.remediation).toMatch(/secretRef/u);
			expect(refusal.remediation.length).toBeGreaterThan(20);
		}
	});

	it.each([
		[{ secretRef: "hunter2-signing-key" }, "an opaque value with no scheme"],
		[
			{ secretRef: "postgres://user:pw@db.example.com/auth" },
			"a connection string",
		],
		[{ secretRef: "Bearer abc123def456" }, "a bearer token"],
		[
			{
				secretRef: syntheticPemLikeSecretRef(),
			},
			"a PEM private key",
		],
		[
			{
				secretRef: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlAAAA",
			},
			"a JWT",
		],
		[
			{ secretRef: "vault://user:pw@vault.example.com/auth/key" },
			"embedded userinfo",
		],
		[
			{ secret: "s3cr3t", secretRef: undefined },
			"a key literally named secret",
		],
	])("rejects %j as an inline secret (%s)", (overrides, _label) => {
		expect(codeOf(() => parseBetterAuthConfig(config(overrides)))).toBe(
			"BETTER_AUTH_SECRET_INLINE",
		);
	});

	it.each([
		[
			{ secretRef: "https://vault.example.com/auth/key" },
			"unregistered scheme",
		],
		[{ secretRef: "vault://authority" }, "no path segment"],
		[{ secretRef: "vault://authority/auth/../../etc" }, "path traversal"],
		[{ secretRef: "VAULT://authority/auth/key" }, "uppercase scheme"],
		[
			{ secretRef: "hobo-secret://camp/auth/key\u0080" },
			"C1 control character",
		],
		[{ secretRef: "vault://camp/auth/%2e%2e/key" }, "escaped path segment"],
		[{ secretRef: "vault://camp?name=other/auth/key" }, "query in authority"],
		[
			{ secretRef: "aws-sm://camp/auth/key#field" },
			"unsupported field selector",
		],
		[{ secretRef: "vault://camp/auth/key#" }, "empty field selector"],
		[{ secretRef: 42 }, "not a string"],
	])("rejects %j as a malformed locator (%s)", (overrides, _label) => {
		expect(codeOf(() => parseBetterAuthConfig(config(overrides)))).toBe(
			"BETTER_AUTH_SECRET_REF_INVALID",
		);
	});

	it.each([
		[{ basePath: undefined }, "missing"],
		[{ basePath: "" }, "empty"],
		[{ basePath: "api/auth" }, "relative"],
		[{ basePath: "/api/auth/" }, "trailing slash"],
		[{ basePath: "/api/../auth" }, "traversal"],
		[{ basePath: "/api/auth?x=1" }, "query string"],
		[{ basePath: "/API/Auth" }, "uppercase"],
		[{ basePath: 7 }, "not a string"],
	])("rejects basePath %j (%s)", (overrides, _label) => {
		expect(codeOf(() => parseBetterAuthConfig(config(overrides)))).toBe(
			"BETTER_AUTH_BASE_PATH_INVALID",
		);
	});

	it.each([
		[{ database: { profile: "kv.redis/v1" } }, "not a data-relational family"],
		[{ database: { profile: "relational" } }, "no version suffix"],
		[{ database: {} }, "no profile"],
		[{ database: { profile: "data.relational/v0" } }, "zero major version"],
	])("rejects database %j (%s)", (overrides, _label) => {
		expect(codeOf(() => parseBetterAuthConfig(config(overrides)))).toBe(
			"BETTER_AUTH_DATABASE_PROFILE_INVALID",
		);
	});

	it("accepts a refinement of the relational profile", () => {
		expect(
			parseBetterAuthConfig(
				config({ database: { profile: "data.postgres/v1" } }),
			).database.profile,
		).toBe("data.postgres/v1");
	});

	it.each([
		[{ socialProviders: "github" }, "not an array"],
		[{ socialProviders: ["GitHub"] }, "not a lowercase slug"],
		[{ socialProviders: [{ id: "github" }] }, "not a string"],
	])("rejects socialProviders %j (%s)", (overrides, _label) => {
		expect(codeOf(() => parseBetterAuthConfig(config(overrides)))).toBe(
			"BETTER_AUTH_SOCIAL_PROVIDER_INVALID",
		);
	});

	it.each([
		[{ plugins: ["passkey"] }, "an unrecognized top-level option"],
		[
			{ organizations: { enabled: true, teams: true } },
			"an unrecognized nested option",
		],
	])("rejects %j rather than dropping it (%s)", (overrides, _label) => {
		expect(codeOf(() => parseBetterAuthConfig(config(overrides)))).toBe(
			"BETTER_AUTH_UNKNOWN_FIELD",
		);
	});

	it.each([
		[undefined, "undefined"],
		[null, "null"],
		["config", "a string"],
		[[], "an array"],
		[{ database: "data.relational/v1" }, "a non-object database block"],
	])("rejects %j as a malformed config shape (%s)", (input, _label) => {
		// SAFETY: malformed-shape cases include `undefined`, outside `JsonValue`, at the parse boundary.
		const value = (isJsonObject(input) ? config(input) : input) as JsonValue;
		expect(codeOf(() => parseBetterAuthConfig(value))).toBe(
			"BETTER_AUTH_CONFIG_SHAPE_INVALID",
		);
	});

	it("honors explicit emailAndPassword and organizations toggles", () => {
		const parsed = parseBetterAuthConfig(
			config({
				emailAndPassword: { enabled: false },
				organizations: { enabled: true },
			}),
		);
		expect(parsed.emailAndPassword).toEqual({ enabled: false });
		expect(parsed.organizations).toEqual({ enabled: true });
	});
});

describe("parseBetterAuthSecretRef", () => {
	it("returns the locator unchanged when it parses", () => {
		expect(parseBetterAuthSecretRef("vault://prod/auth/key#value")).toBe(
			"vault://prod/auth/key#value",
		);
	});

	it("never interpolates the rejected input into the message", () => {
		try {
			parseBetterAuthSecretRef("super-secret-signing-material");
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(BetterAuthConfigError);
			// SAFETY: assertion to `error as Error` is required at this boundary.
			expect((error as Error).message).not.toContain(
				"super-secret-signing-material",
			);
		}
	});
});
