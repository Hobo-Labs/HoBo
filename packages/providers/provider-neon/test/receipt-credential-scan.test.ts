import { parseSecretRef } from "@hobo/bindings";
import { createClaimableOperationKeyDeriver } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createNeonClient,
} from "../src/client.js";
import { createNeonClaimableDatabaseDriver } from "../src/driver.js";
import { NeonProviderError } from "../src/errors.js";
import { parseJsonValue } from "../src/json.js";
import {
	assertNoCredentialMaterial,
	NEON_BINDING_PROFILE_REFS,
	NEON_MIGRATION_PROFILE_REFS,
	scanForCredentialMaterial,
	toProviderFacts,
	toProvisionReceipt,
} from "../src/receipt.js";
import {
	createStubCustody,
	createStubTransport,
	FIXTURE_NOW_MS,
	fixture,
} from "./harness.js";

async function provision() {
	const custody = createStubCustody();
	const clock = () => FIXTURE_NOW_MS;
	const driver = createNeonClaimableDatabaseDriver({
		client: createNeonClient({
			transport: createStubTransport([
				{ status: 200, body: fixture("create-database.unclaimed.json") },
			]),
			store: createInMemoryIdempotencyStore(),
			clock,
		}),
		custody,
		clock,
	});
	const record = await driver.provision({
		resourceRef: "hobo://yard/demo/database",
		ref: "hobo-test",
		idempotencyKey: "provider-receipt-fixture",
	});
	const options = {
		custody,
		deriveOperationKey: createClaimableOperationKeyDeriver(
			Uint8Array.from({ length: 32 }, (_, i) => i + 1),
		),
		scope: {
			tenantId: "tenant",
			providerAccountId: "anonymous",
			scopeId: "deployment",
		},
	};
	return { record, custody, options };
}

describe("Neon public credential scan", () => {
	it.each([
		["postgres://a:b@db/main", "postgres-uri"],
		["POSTGRESQL://a:b@db/main", "postgres-uri"],
		["Bearer abc123", "bearer-token"],
		["PGPASSWORD: hunter2", "password-assignment"],
		["npg_AbCd1234", "neon-role-password"],
		["amqps://user:pass@broker/", "userinfo-pair"],
		["-----BEGIN RSA PRIVATE KEY-----\nMIIE", "private-key"],
		["https://neon.new/claim/private-id", "claim-capability-url"],
	])("recognizes %s without exposing its content", (value, rule) => {
		const hits = scanForCredentialMaterial({ nested: { value } });
		expect(hits.map((hit) => hit.rule)).toContain(rule);
		expect(JSON.stringify(hits)).not.toContain(value);
		expect(hits[0]?.excerpt).toMatch(/^\[redacted:/u);
	});
	it("recognizes native capability identity fields", () => {
		expect(
			scanForCredentialMaterial({ databaseId: "private-native-id" }).map(
				(hit) => hit.rule,
			),
		).toContain("native-capability-id");
		expect(() =>
			assertNoCredentialMaterial(
				{ databaseId: "private-native-id" },
				"receipt",
			),
		).toThrow("native-capability-id");
	});
	it("reports every matching rule with bounded, control-free excerpts", () => {
		const hits = scanForCredentialMaterial({
			uri: `postgres://a:${"p".repeat(80)}@db/main`,
			auth: "Bearer abc123",
		});
		expect(hits.map((hit) => hit.rule)).toEqual(
			expect.arrayContaining(["postgres-uri", "bearer-token"]),
		);
		for (const hit of hits) {
			expect(hit.excerpt.length).toBeLessThan(40);
			expect(hit.excerpt).not.toContain("pppppppppppppppppppp");
			for (const char of hit.excerpt) {
				expect(char.charCodeAt(0)).toBeGreaterThan(0x1f);
			}
		}
		try {
			assertNoCredentialMaterial(
				{ uri: "postgres://a:b@db/main", auth: "Bearer abc123" },
				"the Neon provision receipt",
			);
			throw new Error("credential scan did not reject the receipt");
		} catch (error) {
			expect(error).toBeInstanceOf(NeonProviderError);
			if (!(error instanceof NeonProviderError)) throw error;
			expect(error.code).toBe("SECRET_CUSTODY_UNAVAILABLE");
			expect(error.message).toContain("the Neon provision receipt");
			expect(error.message).toContain("postgres-uri");
			expect(error.message).toContain("bearer-token");
		}
	});
	it("accepts ordinary nonsecret metadata and custody references", () => {
		expect(
			scanForCredentialMaterial({
				host: "db.example",
				tls: true,
				claimRef: "vault://claims/opaque",
			}),
		).toEqual([]);
		expect(() =>
			assertNoCredentialMaterial({ host: "db.example" }, "receipt"),
		).not.toThrow();
	});
});

describe("Neon custody-required public serialization", () => {
	it("seals native ids, project ids, claim URLs, endpoints and bindings", async () => {
		const { record, custody, options } = await provision();
		const receipt = await toProvisionReceipt(record, options);
		const facts = await toProviderFacts(record, options);
		const serialized = JSON.stringify({ receipt, facts });
		for (const hidden of [
			record.databaseId,
			record.neonProjectId,
			record.claim.claimUrl,
		])
			expect(serialized).not.toContain(hidden);
		expect(receipt.schemaVersion).toBe("hobo.provider-neon.receipt/v2");
		expect(receipt.opaquePhysicalId).toMatch(/^claimable:[a-f0-9]{64}$/u);
		expect(receipt.bindingProfiles).toBe(NEON_BINDING_PROFILE_REFS);
		expect(receipt.migrationProfiles).toBe(NEON_MIGRATION_PROFILE_REFS);
		expect(
			(
				await custody.resolve(parseSecretRef(receipt.nativeIdentityRef).ref)
			).expose(),
		).toBe(record.databaseId);
		expect(
			(
				await custody.resolve(parseSecretRef(receipt.claim.claimRef).ref)
			).expose(),
		).toBe(record.claim.claimUrl);
		expect(scanForCredentialMaterial(parseJsonValue(serialized))).toEqual([]);
		expect(
			JSON.stringify(custody.deposits.map((item) => item.scope)),
		).not.toContain(record.databaseId);
	});
	it("hashes source resource identities even when they embed a native capability", async () => {
		const { record, options } = await provision();
		const contaminated = {
			...record,
			resourceRef: `hobo://resource/${record.databaseId}`,
		};
		expect(
			JSON.stringify(await toProvisionReceipt(contaminated, options)),
		).not.toContain(record.databaseId);
	});
	it("requires custody and a private host key even at a JavaScript call boundary", async () => {
		const { record } = await provision();
		// @ts-expect-error JavaScript callers can omit mandatory custody options.
		await expect(toProvisionReceipt(record)).rejects.toThrow("private custody");
		// @ts-expect-error JavaScript callers can omit mandatory custody options.
		await expect(toProviderFacts(record)).rejects.toThrow("private custody");
	});
	it("refuses custody locators containing native ids, and masks custody error causes", async () => {
		const { record, options } = await provision();
		await expect(
			toProvisionReceipt(record, {
				...options,
				custody: {
					async deposit() {
						return `vault://public/${record.databaseId}`;
					},
				},
			}),
		).rejects.toThrow("capability material");
		let error: Error | undefined;
		try {
			await toProvisionReceipt(record, {
				...options,
				custody: {
					async deposit() {
						throw new Error(record.databaseId);
					},
				},
			});
		} catch (cause) {
			if (cause instanceof Error) error = cause;
			else throw cause;
		}
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).not.toContain(record.databaseId);
		expect(error?.cause).toBeUndefined();
	});
	it("rejects poisoned public fields and malformed existing credential locators", async () => {
		const { record, options } = await provision();
		await expect(
			toProvisionReceipt(
				{ ...record, databaseName: "password=hunter2" },
				options,
			),
		).rejects.toThrow("credential-shaped");
		await expect(
			toProvisionReceipt(
				{
					...record,
					credentialRef: parseSecretRef("vault://safe/value").ref,
					providerStatus: "UNCLAIMED",
					databaseName: record.databaseId,
				},
				options,
			),
		).rejects.toThrow("capability material");
	});
	it("refuses case and URI-encoded native capability variants", async () => {
		const { record, options } = await provision();
		for (const databaseName of [
			record.databaseId.toUpperCase(),
			record.databaseId.replaceAll("-", "%2D"),
			record.databaseId.replaceAll("-", "%252D"),
		])
			await expect(
				toProvisionReceipt({ ...record, databaseName }, options),
			).rejects.toThrow("capability material");
	});
	it("preserves distinct adopted, rotation and expiry facts without native identities", async () => {
		const { record, options } = await provision();
		for (const state of [
			"claimed-pending-rotation",
			"complete",
			"expired",
		] as const) {
			const facts = await toProviderFacts(
				{ ...record, adopted: true, claim: { ...record.claim, state } },
				options,
			);
			expect(facts[0]?.kind).toBe("provider.neon.database.adopted");
			expect(facts).toHaveLength(2);
			expect(new Set(facts.map((fact) => fact.occurredAtMs)).size).toBe(1);
			expect(JSON.stringify(facts)).not.toContain(record.databaseId);
		}
	});
});
