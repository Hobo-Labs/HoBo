import { generateKeyPairSync, randomBytes } from "node:crypto";
import {
	type InfisicalClient,
	parseInfisicalBinding,
} from "@hobo/adapter-infisical";
import { describe, expect, it } from "vitest";
import { RelayRuntimeConfigSchema as RelayRuntimeConfigProto } from "../src/_generated/relay_runtime_config_pb.js";
import {
	createRelayRuntimeConfigLoader,
	envRelayConfigSource,
	infisicalRelayConfigSource,
	parseRelayRuntimeConfig,
	type RelayConfigSource,
	RelayRuntimeConfigError,
	relayConfigSourceFromEnv,
} from "../src/relay-runtime-config.js";
import {
	RELAY_RUNTIME_CONFIG_KEYS,
	RELAY_RUNTIME_CONFIG_SETTINGS,
} from "../src/relay-runtime-config-schema.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
	.privateKey.export({ type: "pkcs8", format: "pem" })
	.toString();

const entries = {
	HOBO_CI_PUBLIC_URL: "https://hobo-ci.vercel.app",
	HOBO_CI_SESSION_KEY: randomBytes(32).toString("base64url"),
	HOBO_CI_BOOTSTRAP_ACCOUNT_ID: "account1",
	HOBO_CI_BOOTSTRAP_TOKEN_SHA256: "a".repeat(64),
	HOBO_CI_CONTROL_TOKENS_JSON: "[]",
	HOBO_CI_CONFIG_JSON: "{}",
	CRON_SECRET: "cron-secret-value-".repeat(3),
	HOBO_CI_GITHUB_APP_ID: "123456",
	HOBO_CI_GITHUB_APP_PRIVATE_KEY: pem,
	HOBO_CI_WEBHOOK_SECRET: "webhook-secret-value-".repeat(2),
	HOBO_CI_GITHUB_APP_CLIENT_ID: "Iv23liFixtureClient",
	HOBO_CI_GITHUB_APP_CLIENT_SECRET: "client-secret-value-0123456789",
} satisfies Record<string, string>;

function stubClient(read: () => Record<string, string>): InfisicalClient {
	const fail = () => Promise.reject(new Error("not used"));
	return {
		binding: parseInfisicalBinding({ projectId: "p", environment: "prod" }),
		async listSecrets() {
			return Object.entries(read()).map(([secretKey, value]) => ({
				secretKey,
				value,
				version: 1,
			}));
		},
		listSecretNames: fail,
		getSecret: fail,
		putSecret: fail,
		signOut() {},
	};
}

function errorOf(run: () => void): RelayRuntimeConfigError {
	try {
		run();
	} catch (error) {
		if (error instanceof RelayRuntimeConfigError) return error;
		throw error;
	}
	throw new Error("expected a RelayRuntimeConfigError");
}

describe("the relay runtime config record", () => {
	it("has exactly the keys of the protobuf record's JSON names", () => {
		expect([...RELAY_RUNTIME_CONFIG_KEYS].sort()).toEqual(
			RelayRuntimeConfigProto.fields.map((field) => field.jsonName).sort(),
		);
	});

	it("marks the same fields optional in both", () => {
		const optional = RelayRuntimeConfigProto.fields
			.filter((field) => field.proto.proto3Optional)
			.map((field) => field.jsonName)
			.sort();
		const schemaOptional = Object.entries(RELAY_RUNTIME_CONFIG_SETTINGS)
			.filter(([, schema]) => schema.safeParse(undefined).success)
			.map(([key]) => key)
			.sort();
		expect(schemaOptional).toEqual(optional);
	});
});

describe("parseRelayRuntimeConfig", () => {
	it("accepts a complete configuration and freezes it", () => {
		const config = parseRelayRuntimeConfig(entries);
		expect(config.HOBO_CI_GITHUB_APP_ID).toBe("123456");
		expect(Object.isFrozen(config)).toBe(true);
	});

	it("accepts cache bindings and offers by name, and names a bad one without its value", () => {
		const config = parseRelayRuntimeConfig({
			...entries,
			VALKEY_URL: "rediss://:valkey-password@valkey.example:6379",
			TURSO_DATABASE_URL: "libsql://relay-cache.turso.io",
			TURSO_AUTH_TOKEN: "turso-token-value",
			BLOB_STORE_ID: "store_abc123",
			HOBO_CI_CACHE_OFFERS_JSON: "{}",
		});
		expect(config.BLOB_STORE_ID).toBe("store_abc123");
		const error = errorOf(() =>
			parseRelayRuntimeConfig({
				...entries,
				VALKEY_URL: "https://valkey-password@valkey.example",
			}),
		);
		expect(error.keys).toEqual(["VALKEY_URL"]);
		expect(error.message).not.toContain("valkey-password");
	});

	it("treats an empty entry as unset", () => {
		expect(
			parseRelayRuntimeConfig({ ...entries, HOBO_CI_SANDBOX_PLAN: "" })
				.HOBO_CI_SANDBOX_PLAN,
		).toBeUndefined();
	});

	it("names missing App credentials without quoting any value", () => {
		const { HOBO_CI_GITHUB_APP_PRIVATE_KEY: _key, ...rest } = entries;
		const error = errorOf(() =>
			parseRelayRuntimeConfig({ ...rest, HOBO_CI_WEBHOOK_SECRET: "short" }),
		);
		expect(error.keys).toEqual([
			"HOBO_CI_GITHUB_APP_PRIVATE_KEY",
			"HOBO_CI_WEBHOOK_SECRET",
		]);
		expect(error.message).not.toContain("short");
	});

	it("refuses a key that is not RSA or too small, without quoting it", () => {
		for (const key of [
			generateKeyPairSync("ec", { namedCurve: "P-256" })
				.privateKey.export({ type: "pkcs8", format: "pem" })
				.toString(),
			generateKeyPairSync("rsa", { modulusLength: 1024 })
				.privateKey.export({ type: "pkcs8", format: "pem" })
				.toString(),
		]) {
			const error = errorOf(() =>
				parseRelayRuntimeConfig({
					...entries,
					HOBO_CI_GITHUB_APP_PRIVATE_KEY: key,
				}),
			);
			expect(error.keys).toEqual(["HOBO_CI_GITHUB_APP_PRIVATE_KEY"]);
			expect(error.message).not.toContain("PRIVATE KEY");
		}
	});

	it("refuses entries the relay does not use, by name", () => {
		const error = errorOf(() =>
			parseRelayRuntimeConfig({ ...entries, VERCEL_DEPLOY_TOKEN: "x" }),
		);
		expect(error.keys).toEqual(["VERCEL_DEPLOY_TOKEN"]);
	});

	it("keeps the onboarding token bound to the owner's control tokens", () => {
		const error = errorOf(() =>
			parseRelayRuntimeConfig({
				...entries,
				HOBO_CI_ONBOARDING_CONTROL_TOKEN: randomBytes(32).toString("base64url"),
			}),
		);
		expect(error.keys).toEqual(["(document)"]);
	});
});

describe("sources", () => {
	it("gives the same configuration from Infisical and from the environment", async () => {
		const fromEnv = await envRelayConfigSource({
			...entries,
			PATH: "/usr/bin",
		}).read();
		const fromInfisical = await infisicalRelayConfigSource(
			stubClient(() => entries),
		).read();
		expect(parseRelayRuntimeConfig(fromInfisical)).toEqual(
			parseRelayRuntimeConfig(fromEnv),
		);
	});

	it("signs in to Infisical with the injected JWT and reads one folder", async () => {
		const jwt = `${Buffer.from("{}").toString("base64url")}.${Buffer.from("{}").toString("base64url")}.sig`;
		const calls: { url: string; init: RequestInit | undefined }[] = [];
		const fetchStub: typeof fetch = async (input, init) => {
			const url = String(input);
			calls.push({ url, init });
			if (url.endsWith("/api/v1/auth/oidc-auth/login"))
				return Response.json({
					accessToken: "relay-access-token",
					expiresIn: 7200,
					accessTokenMaxTTL: 7200,
					tokenType: "Bearer",
				});
			return Response.json({
				secrets: Object.entries(entries).map(([secretKey, secretValue]) => ({
					secretKey,
					secretValue,
					version: 1,
					type: "shared",
					secretValueHidden: false,
				})),
				imports: [],
			});
		};
		const source = relayConfigSourceFromEnv(
			{
				HOBO_CI_CONFIG_SERVICE: "infisical",
				INFISICAL_IDENTITY_ID: "relay-identity",
				INFISICAL_PROJECT_ID: "proj-1",
				INFISICAL_ENVIRONMENT: "prod",
				INFISICAL_SECRET_PATH: "/hobo-ci-relay",
			},
			{ jwt: async () => jwt, fetch: fetchStub },
		);
		expect(source.kind).toBe("infisical");
		const config = parseRelayRuntimeConfig(await source.read());
		expect(config.HOBO_CI_PUBLIC_URL).toBe("https://hobo-ci.vercel.app");
		expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
			"/api/v1/auth/oidc-auth/login",
			"/api/v4/secrets",
		]);
		expect(calls[0]?.url.startsWith("https://app.infisical.com/")).toBe(true);
		expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
			identityId: "relay-identity",
			jwt,
		});
	});

	it("defaults to the environment and refuses an unknown service", () => {
		expect(relayConfigSourceFromEnv({}).kind).toBe("env");
		expect(() =>
			relayConfigSourceFromEnv({ HOBO_CI_CONFIG_SERVICE: "vault" }),
		).toThrow(/HOBO_CI_CONFIG_SERVICE/u);
		expect(() =>
			relayConfigSourceFromEnv({ HOBO_CI_CONFIG_SERVICE: "infisical" }),
		).toThrow(/invalid-input/u);
	});
});

describe("the loader", () => {
	function counting(read: () => Record<string, string>) {
		let reads = 0;
		const source: RelayConfigSource = {
			kind: "env",
			async read() {
				reads++;
				return read();
			},
		};
		return { source, reads: () => reads };
	}

	it("reads once per TTL and shares a read between concurrent loads", async () => {
		let clock = 0;
		const { source, reads } = counting(() => entries);
		const loader = createRelayRuntimeConfigLoader({
			source,
			ttlMs: 60_000,
			now: () => clock,
		});
		await Promise.all([loader.load(), loader.load(), loader.load()]);
		clock = 59_999;
		await loader.load();
		expect(reads()).toBe(1);
		clock = 60_000;
		await loader.load();
		expect(reads()).toBe(2);
	});

	it("keeps the last good copy when a refresh fails, and reports it", async () => {
		let clock = 0;
		let broken = false;
		const reported: unknown[] = [];
		const { source } = counting(() => {
			if (broken) throw new Error("infisical list secrets failed: unavailable");
			return entries;
		});
		const loader = createRelayRuntimeConfigLoader({
			source,
			now: () => clock,
			onRefreshFailed: (error) => reported.push(error),
		});
		const first = await loader.load();
		broken = true;
		clock = 120_000;
		expect(await loader.load()).toBe(first);
		expect(reported).toHaveLength(1);
		clock = 120_001;
		await loader.load();
		expect(reported).toHaveLength(1);
	});

	it("fails a cold start that cannot read or parse", async () => {
		const loader = createRelayRuntimeConfigLoader({
			source: counting(() => ({ ...entries, CRON_SECRET: "x" })).source,
		});
		await expect(loader.load()).rejects.toThrow(/CRON_SECRET/u);
	});
});
