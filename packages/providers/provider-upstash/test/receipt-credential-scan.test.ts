/**
 * Upstash receipts and facts — and the credential scan that guards them.
 *
 * These artifacts land in a plan, an append-only event log, and a support
 * bundle. A leaked credential in any of those cannot be retracted, and an
 * Upstash REST token grants full read/write on the database, so the module
 * does two separate things.
 *
 * **It projects rather than spreads.** A receipt is assembled field by field
 * from the record, so a future field — a token, a URL with userinfo — is not
 * republished by default. A spread would carry it out automatically.
 *
 * **It re-scans the finished artifact anyway.** The projection is a rule a
 * later edit can break; the scan is the check that notices. It is also
 * deliberately broader than Neon's: an `opaque-blob` rule catches any long
 * unbroken token-shaped run, because an Upstash REST token has no distinctive
 * prefix to key on.
 *
 * That breadth has a cost worth pinning: the blob rule fires on anything long
 * and unbroken, so receipt content has to stay below it. That is a real
 * constraint on what may be put in a detail field, not an accident.
 */
import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createUpstashClient,
} from "../src/client.js";
import type { UpstashTemporaryRedis } from "../src/driver.js";
import { createUpstashTemporaryRedisDriver } from "../src/driver.js";
import { UpstashProviderError } from "../src/errors.js";
import type { JsonValue } from "../src/json.js";
import {
	assertNoCredentialMaterial,
	scanForCredentialMaterial,
	toProviderFacts,
	toProvisionReceipt,
} from "../src/receipt.js";
import {
	createStubCustody,
	createStubTransport,
	FAKE_CONSOLE_URL,
	FAKE_DATABASE_ID,
	FIXTURE_CREATED_AT_MS,
} from "./fixtures/index.js";
import { publicOptions } from "./public-serialization.js";

async function fixtureRecord(
	overrides: Partial<UpstashTemporaryRedis> = {},
): Promise<UpstashTemporaryRedis> {
	const driver = createUpstashTemporaryRedisDriver({
		client: createUpstashClient({
			transport: createStubTransport({}),
			store: createInMemoryIdempotencyStore(),
			clock: () => FIXTURE_CREATED_AT_MS,
		}),
		custody: createStubCustody(),
		clock: () => FIXTURE_CREATED_AT_MS,
	});
	return {
		...(await driver.provision({
			resourceRef: `logical/${FAKE_DATABASE_ID}`,
			idempotencyKey: FAKE_DATABASE_ID,
		})),
		...overrides,
	};
}

const rulesFor = (value: JsonValue) =>
	scanForCredentialMaterial(value).map((hit) => hit.rule);

describe("the credential scan", () => {
	it("finds nothing in a value with no credential material", () => {
		expect(
			scanForCredentialMaterial({
				host: "db-1.upstash.io",
				tls: true,
			}),
		).toEqual([]);
	});

	it("catches a Redis URI under either scheme", () => {
		// The URI carries the token in its userinfo — the single most likely
		// thing to leak, because it is what the provider returns.
		expect(rulesFor({ uri: "redis://db/0" })).toContain("redis-uri");
		expect(rulesFor({ uri: "REDISS://db/0" })).toContain("redis-uri");
	});

	it("catches a bearer token and a token assignment", () => {
		expect(rulesFor({ auth: "Bearer abc12345" })).toContain("bearer-token");
		for (const value of ["token=abcdefghijkl", "password: abcdefghijkl"]) {
			expect(rulesFor({ note: value }), value).toContain("token-assignment");
		}
		// A quoted value does not match, because the scan runs over the JSON
		// serialization: the inner quotes arrive escaped as `\"`, and the
		// pattern's character class stops at the quote after one character.
		// Pinned as-is — the quoted form is caught by the opaque-blob rule
		// instead when the value is long enough, so the gap is narrower than it
		// looks, and tightening this pattern risks false positives on ordinary
		// JSON.
		expect(rulesFor({ note: 'pwd="abcdefghijkl"' })).not.toContain(
			"token-assignment",
		);
	});

	it("catches the REST token environment variable by name", () => {
		// A published `.env` snippet is a realistic way for a token to end up in
		// a support bundle, and the variable name is the tell.
		expect(rulesFor({ v: "UPSTASH_REDIS_REST_TOKEN=x" })).toContain(
			"upstash-rest-token-env",
		);
	});

	it("catches a userinfo pair and a private key header", () => {
		expect(rulesFor({ v: "rediss://default:pw@db/" })).toContain(
			"userinfo-pair",
		);
		expect(rulesFor({ v: "-----BEGIN EC PRIVATE KEY-----" })).toContain(
			"private-key",
		);
	});

	it("catches any long unbroken token-shaped run", () => {
		// An Upstash REST token has no distinctive prefix, so the scan falls
		// back to shape. This is broader than Neon's equivalent on purpose.
		expect(rulesFor({ v: "A".repeat(40) })).toContain("opaque-blob");
		expect(rulesFor({ v: "A".repeat(39) })).not.toContain("opaque-blob");
	});

	it("reports every rule that fired", () => {
		const rules = rulesFor({ uri: "redis://db/0", auth: "Bearer abc12345" });
		expect(rules).toContain("redis-uri");
		expect(rules).toContain("bearer-token");
	});

	it("scans nested values", () => {
		expect(rulesFor({ a: { b: ["redis://db/0"] } })).toContain("redis-uri");
	});

	it("keeps its excerpt short and free of control characters", () => {
		// The excerpt lands in an error that lands in a log. Eight characters
		// past the match is enough to locate the field and not enough to be a
		// usable credential.
		const hit = scanForCredentialMaterial({
			v: `padding-padding-rediss://default:${"p".repeat(60)}@db/`,
		})[0];
		expect(hit?.excerpt.length).toBeLessThan(40);
		// Control characters are replaced with spaces so an excerpt cannot
		// forge a line in the log it lands in.
		expect(
			[...(hit?.excerpt ?? "")].every(
				(character) =>
					character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
			),
		).toBe(true);
	});

	it("leaves ordinary receipt content alone", () => {
		// A false positive refuses a legitimate receipt, so hosts, ISO
		// timestamps, and secret *references* have to pass.
		expect(
			scanForCredentialMaterial({
				host: "db-1.upstash.io",
				expiresAtIso: "2026-07-01T00:00:00.000Z",
				credentialRef: "secret://upstash/db-1/rest",
			}),
		).toEqual([]);
	});
});

describe("assertNoCredentialMaterial", () => {
	it("passes a clean value silently", () => {
		expect(() =>
			assertNoCredentialMaterial({ host: "db.upstash.io" }, "x"),
		).not.toThrow();
	});

	it("throws under the secret-reference code, naming the artifact and rules", () => {
		let error: UpstashProviderError | undefined;
		try {
			assertNoCredentialMaterial(
				{ uri: "redis://db/0" },
				"the Upstash provision receipt",
			);
		} catch (thrown) {
			if (thrown instanceof UpstashProviderError) error = thrown;
		}
		expect(error).toBeInstanceOf(UpstashProviderError);
		expect(error?.code).toBe("SECRET_REFERENCE_INVALID");
		expect(error?.message).toContain("the Upstash provision receipt");
		expect(error?.message).toContain("redis-uri");
	});
});

describe("custody-required public receipts and facts", () => {
	it("seals native capabilities and hashes resource metadata even when the input ref includes a native id", async () => {
		const record = await fixtureRecord();
		const custody = createStubCustody();
		const options = publicOptions(custody);
		const receipt = await toProvisionReceipt(record, options);
		const facts = await toProviderFacts(record, options);
		expect(receipt.schemaVersion).toBe("hobo.provider-upstash.receipt/v2");
		expect(receipt.opaquePhysicalId).toMatch(/^claimable:[a-f0-9]{64}$/u);
		expect(receipt.resourceRef).toMatch(/^claimable:[a-f0-9]{64}$/u);
		expect(receipt.nativeIdentityRef).toMatch(/^hobo-secret:\/\//u);
		expect(receipt.claim.claimRef).toMatch(/^hobo-secret:\/\//u);
		const serialized = JSON.stringify({ receipt, facts });
		expect(serialized).not.toContain(FAKE_DATABASE_ID);
		expect(serialized).not.toContain(FAKE_DATABASE_ID.replaceAll("-", ""));
		expect(serialized).not.toContain(FAKE_CONSOLE_URL);
		expect([...custody.deposited.values()]).toContain(FAKE_DATABASE_ID);
		expect([...custody.deposited.values()]).toContain(FAKE_CONSOLE_URL);
		expect(facts[0]?.opaquePhysicalId).toBe(receipt.opaquePhysicalId);
		expect(facts[0]?.schemaVersion).toBe("hobo.provider-upstash.fact/v2");
	});
	it("preserves documented capability limits and expiry without inventing deletion or export", async () => {
		const record = await fixtureRecord();
		const receipt = await toProvisionReceipt(record, publicOptions());
		expect(receipt.endpoint).toEqual({
			host: record.restEndpointHost,
			port: 443,
			tls: true,
			transport: "https-rest",
		});
		expect(receipt.limits).toEqual(record.limits);
		expect(receipt.expiresAtIso).toBe(record.expiresAtIso);
		expect(receipt.statedTtlDays).toBe(record.statedTtlDays);
		expect(receipt.teardown).toBe("expiry-only");
		expect(receipt.migrationProfiles).toEqual([]);
		expect(receipt.bindingProfiles).toContain("binding.redis-rest/v1");
	});
	it("retains optional credential locators and filters completed/nonblocking claim actions", async () => {
		const initial = await fixtureRecord();
		const record = {
			...initial,
			claim: {
				...initial.claim,
				actions: [
					{
						id: "blocking",
						kind: "human-ceremony" as const,
						description: "outstanding",
						blocking: true,
						completed: false,
					},
					{
						id: "complete",
						kind: "human-ceremony" as const,
						description: "done",
						blocking: true,
						completed: true,
					},
					{
						id: "optional",
						kind: "human-ceremony" as const,
						description: "optional",
						blocking: false,
						completed: false,
					},
				],
			},
		};
		const receipt = await toProvisionReceipt(record, publicOptions());
		expect(receipt.credentialRef).toBe(record.credentialRef);
		expect(receipt.restUrlRef).toBe(record.restUrlRef);
		expect(receipt.claim.blockingActionIds).toEqual(["blocking"]);
	});
	it("emits the correct state facts with only opaque identity correlation", async () => {
		const initial = await fixtureRecord();
		for (const state of [
			"unclaimed",
			"claimed-pending-rotation",
			"complete",
			"expired",
		] as const) {
			const record = { ...initial, claim: { ...initial.claim, state } };
			const facts = await toProviderFacts(record, publicOptions());
			expect(facts[0]?.kind).toBe("provider.upstash.database.provisioned");
			if (state === "claimed-pending-rotation")
				expect(facts.map((fact) => fact.kind)).toContain(
					"provider.upstash.claim.pending-rotation",
				);
			if (state === "complete")
				expect(facts.map((fact) => fact.kind)).toContain(
					"provider.upstash.claim.completed",
				);
			if (state === "expired")
				expect(facts.map((fact) => fact.kind)).toContain(
					"provider.upstash.lease.expired",
				);
			expect(new Set(facts.map((fact) => fact.resourceRef)).size).toBe(1);
		}
		expect(
			(await toProviderFacts({ ...initial, adopted: true }, publicOptions()))[0]
				?.kind,
		).toBe("provider.upstash.database.adopted");
	});
	it("refuses missing custody or a custody locator that republishes the native capability", async () => {
		const record = await fixtureRecord();
		const missing = publicOptions();
		Object.defineProperty(missing, "custody", { value: undefined });
		await expect(toProvisionReceipt(record, missing)).rejects.toThrow(
			"requires private custody",
		);
		const bad = publicOptions({
			async deposit() {
				return `hobo-secret://unsafe/${FAKE_DATABASE_ID}`;
			},
		});
		await expect(toProvisionReceipt(record, bad)).rejects.toThrow(
			"native capability",
		);
		await expect(toProviderFacts(record, bad)).rejects.toThrow(
			"native capability",
		);
	});
	it("refuses case-folded, compact, and percent-encoded native capabilities in public fields and custody locators", async () => {
		const record = await fixtureRecord();
		for (const capability of [
			FAKE_DATABASE_ID.toUpperCase(),
			FAKE_DATABASE_ID.toUpperCase().replaceAll("-", ""),
			FAKE_DATABASE_ID.toUpperCase().replaceAll("-", "%2D"),
			FAKE_DATABASE_ID.replaceAll("-", "%252d"),
			FAKE_CONSOLE_URL.toUpperCase(),
		]) {
			const options = publicOptions({
				async deposit() {
					return `hobo-secret://unsafe/${capability}`;
				},
			});
			await expect(toProvisionReceipt(record, options)).rejects.toThrow(
				"native capability",
			);
			await expect(toProviderFacts(record, options)).rejects.toThrow(
				"native capability",
			);
			const poisoned = { ...record, definitionId: capability };
			await expect(
				toProvisionReceipt(poisoned, publicOptions()),
			).rejects.toThrow("native capability");
			await expect(toProviderFacts(poisoned, publicOptions())).rejects.toThrow(
				"native capability",
			);
		}
	});
	it("never republishes a secret from an upstream custody exception or its cause", async () => {
		const record = await fixtureRecord();
		const options = publicOptions({
			async deposit() {
				throw new Error(`${FAKE_DATABASE_ID} ${FAKE_CONSOLE_URL}`);
			},
		});
		let failure: Error | undefined;
		try {
			await toProvisionReceipt(record, options);
		} catch (error) {
			if (error instanceof Error) failure = error;
		}
		expect(failure).toBeInstanceOf(UpstashProviderError);
		expect(JSON.stringify(failure)).not.toContain(FAKE_DATABASE_ID);
		expect(String(failure)).not.toContain(FAKE_DATABASE_ID);
		expect(failure).not.toHaveProperty("cause");
	});
	it("rejects credential-bearing projected fields and ignores extra private fields", async () => {
		const record = await fixtureRecord();
		await expect(
			toProvisionReceipt(
				{ ...record, restEndpointHost: "db.upstash.io/?token=abcdefghijkl" },
				publicOptions(),
			),
		).rejects.toThrow("credential-shaped");
		const poisoned = { ...record };
		Object.defineProperty(poisoned, "expirySource", { value: "A".repeat(40) });
		await expect(toProviderFacts(poisoned, publicOptions())).rejects.toThrow(
			"credential-shaped",
		);
		const extended = {
			...record,
			unpublishedNativeValue: "rediss://default:private@db/",
		};
		expect(
			JSON.stringify(await toProvisionReceipt(extended, publicOptions())),
		).not.toContain("rediss://");
	});
});
