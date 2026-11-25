import { describe, expect, it } from "vitest";

import {
	asHoboSecretsStore,
	assertNoPlaintextConformance,
	assertNoPlaintextInEvent,
	createAwsSecretsManagerPort,
	createAzureKeyVaultPort,
	createCampSecretsPort,
	createContractAssertedConfigFixtures,
	createLocalStationSecretsPort,
	createMemorySecretsPort,
	createVaultJwtSecretsPort,
	decryptLocalOverrides,
	encryptLocalOverrides,
	requireNoPlaintextConformance,
	resolveConfigEntry,
	resolveConfigSchema,
} from "../src/index.js";

const schema = {
	kind: "config-schema" as const,
	schemaVersion: "hobo.config-schema/v1" as const,
	schemaHash: "sha256:test" as const,
	fields: {
		LOG_LEVEL: {
			kind: "config-field" as const,
			name: "LOG_LEVEL",
			type: "string" as const,
			required: false,
			sensitive: false,
			source: "camp-value" as const,
			defaultValue: "info",
		},
		DB_URL: {
			kind: "config-field" as const,
			name: "DB_URL",
			type: "string" as const,
			required: true,
			sensitive: true,
			source: "bound-resource" as const,
		},
		API_KEY: {
			kind: "config-field" as const,
			name: "API_KEY",
			type: "string" as const,
			required: true,
			sensitive: true,
			source: "provider-federation" as const,
		},
	},
};

describe("secretless resolution ladder", () => {
	it("prefers bound-resource over lower ranks", async () => {
		const result = await resolveConfigEntry({
			name: "DB_URL",
			sensitive: true,
			preferredSource: "bound-resource",
			allowedSources: [
				"bound-resource",
				"provider-federation",
				"camp-value",
				"static-escape",
			],
			boundToken: async () => "short-lived-svid-token",
			campValue: "should-not-use",
		});
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.entry.source).toBe("bound-resource");
			expect(result.entry.placeholder).toMatch(/REDACTED/);
			expect(result.entry.value).toBeUndefined();
		}
	});

	it("provider-federation uses secrets port without exposing material on entry", async () => {
		const port = createMemorySecretsPort();
		await port.put("API_KEY", "real-secret-value-xyz");
		const result = await resolveConfigEntry({
			name: "API_KEY",
			sensitive: true,
			preferredSource: "provider-federation",
			allowedSources: ["provider-federation"],
			secretsPort: port,
		});
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.entry.placeholder).toMatch(/REDACTED/);
			expect(JSON.stringify(result.entry)).not.toContain(
				"real-secret-value-xyz",
			);
		}
	});

	it("resolveConfigSchema emits redacted events with sensitivity", async () => {
		const port = createMemorySecretsPort();
		await port.put("API_KEY", "real-secret-value-xyz");
		const resolved = await resolveConfigSchema({
			tenant: "t1",
			schema,
			campValues: { LOG_LEVEL: "debug" },
			secretsPort: port,
			boundTokens: {
				DB_URL: async () => "tok_db",
			},
			forbidStaticEscape: true,
		});
		expect(resolved.agentView.LOG_LEVEL).toBe("debug");
		expect(resolved.agentView.DB_URL).toMatch(/REDACTED/);
		expect(resolved.agentView.API_KEY).toMatch(/REDACTED/);
		expect(JSON.stringify(resolved.agentView)).not.toContain(
			"real-secret-value-xyz",
		);
		expect(resolved.entries.LOG_LEVEL?.sensitivity).toBe("public");
		expect(resolved.entries.DB_URL?.sensitivity).toBe("sensitive");
		expect(resolved.entries.API_KEY?.sensitivity).toBe("sensitive");
		expect(resolved.entries.API_KEY?.value).toBeUndefined();
		for (const e of resolved.events) {
			assertNoPlaintextInEvent(e);
			expect(e.data.redacted).toBe(true);
			if (e.type === "config.Resolved") {
				expect(e.data.sensitivity).toBeTruthy();
				expect(JSON.stringify(e.data)).not.toContain("real-secret-value-xyz");
			}
		}
		expect(resolved.events.some((e) => e.type === "config.Resolved")).toBe(
			true,
		);
		expect(resolved.events.some((e) => e.type === "secret.Accessed")).toBe(
			true,
		);
	});

	it("Vault JWT adapter works without static vault token", async () => {
		const vault = createVaultJwtSecretsPort({
			vaultAddr: "https://vault.example",
			role: "hobo-workload",
			svidJwt: "eyJhbGciOiJFUzI1NiJ9.svid.fixture",
		});
		await vault.put("app/db", "seed");
		const accessed = await vault.access("app/db");
		expect(accessed.status).toBe("ok");
		if (accessed.status === "ok") {
			expect(accessed.valueRef).toMatch(/^vault:\/\//);
			expect(accessed.expiresAt).toBeTruthy();
		}
	});

	it("local station residual defaults to memory (no OpenBao in default install)", async () => {
		const port = createLocalStationSecretsPort({ stationId: "local" });
		expect(port.kind).toBe("memory-fixture");
		await port.put("API_KEY", "broker-only");
		const result = await resolveConfigEntry({
			name: "API_KEY",
			sensitive: true,
			preferredSource: "provider-federation",
			allowedSources: ["provider-federation"],
			secretsPort: port,
		});
		expect(result.status).toBe("resolved");
		if (result.status === "resolved") {
			expect(result.entry.placeholder).toMatch(/REDACTED/);
			expect(JSON.stringify(result.entry)).not.toContain("broker-only");
		}
	});

	it("requesting OpenBao residual without optional package fails closed", () => {
		expect(() =>
			createLocalStationSecretsPort({
				env: { HOBO_LOCAL_SECRETS_BACKEND: "openbao" },
			}),
		).toThrow(/@hobo\/adapter-openbao/);
	});

	it("static-escape forbidden when policy forbids", async () => {
		await expect(
			resolveConfigSchema({
				tenant: "t1",
				schema: {
					kind: "config-schema",
					schemaVersion: "hobo.config-schema/v1",
					schemaHash: "sha256:x",
					fields: {
						LEGACY: {
							kind: "config-field",
							name: "LEGACY",
							type: "string",
							required: true,
							sensitive: true,
							source: "static-escape",
							ttl: "7d",
							rotation: "required",
						},
					},
				},
				forbidStaticEscape: true,
				staticMaterials: { LEGACY: "pw" },
			}),
		).rejects.toThrow(/required config/);
	});

	it("contract-asserted dev fixtures resolve without agent-visible secrets", async () => {
		const fixtures = await createContractAssertedConfigFixtures(schema, {
			seedSecrets: { API_KEY: "seeded-only-in-broker" },
		});
		expect(fixtures.forbidStaticEscape).toBe(true);
		const resolved = await resolveConfigSchema({
			tenant: "dev",
			schema,
			campValues: fixtures.campValues,
			secretsPort: fixtures.secretsPort,
			boundTokens: fixtures.boundTokens,
			forbidStaticEscape: fixtures.forbidStaticEscape,
			allowedSources: fixtures.allowedSources,
		});
		expect(resolved.agentView.DB_URL).toMatch(/REDACTED/);
		expect(resolved.agentView.API_KEY).toMatch(/REDACTED/);
		expect(JSON.stringify(resolved.agentView)).not.toContain(
			"seeded-only-in-broker",
		);
		requireNoPlaintextConformance({
			agentContext: resolved.agentView,
			events: resolved.events,
			iacState: { outputs: { db: resolved.entries.DB_URL?.valueRef } },
			logs: "resolved config",
		});
	});

	it("AWS SM and Azure KV ports support injected live fetch", async () => {
		const calls: string[] = [];
		const fetch = async (url: string) => {
			calls.push(url);
			return {
				ok: true,
				status: 200,
				json: async () => ({
					VersionId: "v-live",
					SecretString: "live-material",
					value: "live-material",
					id: "https://vault/secrets/k/v-live",
				}),
				text: async () => "",
			};
		};
		const aws = createAwsSecretsManagerPort({
			region: "eu-west-1",
			fetch,
			accessToken: "brokered",
		});
		const awsAccess = await aws.access("app/key");
		expect(awsAccess.status).toBe("ok");
		if (awsAccess.status === "ok") {
			expect(awsAccess.valueRef).toMatch(/^aws-sm:\/\//);
			expect(awsAccess.material).toBe("live-material");
		}
		const az = createAzureKeyVaultPort({
			vaultName: "prod-kv",
			fetch,
			accessToken: "brokered",
		});
		const azAccess = await az.access("app-key");
		expect(azAccess.status).toBe("ok");
		expect(calls.length).toBeGreaterThan(0);

		const camp = createCampSecretsPort({ backend: "vault-jwt" });
		const store = asHoboSecretsStore(camp);
		const versionId = await store.put(
			"x",
			new Uint8Array(Buffer.from("v", "utf8")),
		);
		expect(versionId).toBeTruthy();
		const latest = await store.access("x");
		expect(latest.versionId).toBe(versionId);
	});

	it("encrypts non-sensitive local overrides only", () => {
		const file = encryptLocalOverrides({
			values: { LOG_LEVEL: "debug", MAX_CONCURRENCY: 8 },
			allowedKeys: ["LOG_LEVEL", "MAX_CONCURRENCY"],
			passphrase: "dev-pass",
		});
		expect(file.schemaVersion).toBe("hobo.local-config-override/v1");
		const plain = decryptLocalOverrides(file, "dev-pass");
		expect(plain.LOG_LEVEL).toBe("debug");
		// Two different refusals live behind this call — "key not in the
		// non-sensitive allowlist" and "this value looks like a secret" — and
		// the previous `/sensitive|not in non-sensitive/i` matched either, so
		// it could not say which one fired. `API_KEY` *is* allowlisted here, so
		// the branch under test is the looks-sensitive one; pin its code.
		let sensitiveRefusal: unknown;
		try {
			encryptLocalOverrides({
				values: { API_KEY: "sk-super-secret-value-12345" },
				allowedKeys: ["API_KEY"],
				passphrase: "x",
			});
		} catch (cause) {
			sensitiveRefusal = cause;
		}
		expect(sensitiveRefusal).toBeInstanceOf(Error);
		// SAFETY: assertion to `itiveRefusal as { code?: unknown }).co` is required at this boundary.
		expect((sensitiveRefusal as { code?: unknown }).code).toBe(
			"override-looks-sensitive",
		);
		// SAFETY: assertion to `itiveRefusal as Error).me` is required at this boundary.
		expect((sensitiveRefusal as Error).message).toBe(
			"local override API_KEY looks sensitive; only non-secret config allowed",
		);
		// The neighbouring branch, so the two can never be confused again.
		expect(() =>
			encryptLocalOverrides({
				values: { LOG_LEVEL: "debug" },
				allowedKeys: [],
				passphrase: "x",
			}),
		).toThrow("local override key LOG_LEVEL is not in non-sensitive allowlist");

		const conf = assertNoPlaintextConformance({
			agentContext: { API_KEY: "[REDACTED:provider-federation:API_KEY]" },
			events: [{ type: "secret.Accessed", valueRef: "secref://API_KEY/v1" }],
		});
		expect(conf.ok).toBe(true);
	});
});
