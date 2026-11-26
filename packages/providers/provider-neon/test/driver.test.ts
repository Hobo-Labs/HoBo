import { describe, expect, it } from "vitest";

import {
	createInMemoryIdempotencyStore,
	createNeonClient,
} from "../src/client.js";
import {
	createNeonClaimableDatabaseDriver,
	type NeonClaimableDatabase,
	type OwnershipProbePort,
} from "../src/driver.js";
import type { NeonProviderError } from "../src/errors.js";
import { parseJsonObject } from "../src/json.js";
import {
	createStubCustody,
	createStubTransport,
	FIXTURE_DATABASE_ID,
	FIXTURE_NOW_MS,
	fixedClock,
	fixture,
	type StubCustody,
	type StubExchange,
} from "./harness.js";

function buildDriver(
	exchanges: readonly StubExchange[],
	options: {
		readonly nowMs?: number;
		readonly probe?: OwnershipProbePort;
	} = {},
) {
	const custody = createStubCustody();
	const transport = createStubTransport(exchanges);
	const clock = fixedClock(options.nowMs ?? FIXTURE_NOW_MS);
	const client = createNeonClient({
		transport,
		store: createInMemoryIdempotencyStore(),
		clock,
	});
	const driver = createNeonClaimableDatabaseDriver({
		client,
		custody,
		clock,
		...(options.probe !== undefined ? { probe: options.probe } : undefined),
	});
	return { driver, custody, transport };
}

async function provisionFixture(
	options: {
		readonly nowMs?: number;
		readonly probe?: OwnershipProbePort;
	} = {},
): Promise<{ record: NeonClaimableDatabase; custody: StubCustody }> {
	const { driver, custody } = buildDriver(
		[{ status: 200, body: fixture("create-database.unclaimed.json") }],
		options,
	);
	const record = await driver.provision({
		ref: "hobo-test",
		idempotencyKey: "hobo:resource:demo-db:0001",
		resourceRef: "hobo://yard/demo/data/main",
	});
	return { record, custody };
}

describe("provision", () => {
	it("deposits the connection string and lets only the locator leave", async () => {
		const { record, custody } = await provisionFixture();

		expect(custody.deposits.map((deposit) => deposit.scope.purpose)).toEqual([
			"connection-string-pooled",
			"connection-string-direct",
		]);
		expect(record.credentialRef).toMatch(/^hobo-secret:\/\//u);
		expect(record.directCredentialRef).toMatch(/^hobo-secret:\/\//u);

		const serialized = JSON.stringify(record);
		expect(serialized).not.toContain("postgresql://");
		expect(serialized).not.toContain("REDACTED");
		expect(serialized).not.toContain("neondb_owner");
	});

	it("publishes only non-secret endpoint metadata", async () => {
		const { record } = await provisionFixture();
		expect(record.endpoints.pooled.host).toBe(
			"ep-fake-000000-pooler.c-2.us-east-2.aws.neon.tech",
		);
		expect(record.endpoints.direct.host).toBe(
			"ep-fake-000000.c-2.us-east-2.aws.neon.tech",
		);
		expect(record.endpoints.pooled.tls).toBe(true);
		expect(record.databaseName).toBe("neondb");
	});

	it("uses the provider-reported expiry and records its source", async () => {
		const { record } = await provisionFixture();
		expect(record.expiresAtIso).toBe("2026-08-11T12:00:00.000Z");
		expect(record.expirySource).toBe("provider-reported");
	});

	it("emits a binding carrying a credential ref and both endpoints", async () => {
		const { record } = await provisionFixture();
		expect(record.binding?.bindingProfileRef).toBe("binding.postgresql/v1");
		expect(record.binding?.capabilityProfileRef).toBe("data.postgres/v1");
		expect(record.binding?.credentialRef).toBe(record.credentialRef);
		expect(
			record.binding?.endpoints.map((endpoint) => endpoint.role).sort(),
		).toEqual(["pooled", "primary"]);
		expect(JSON.stringify(record.binding)).not.toContain("postgresql://");
	});
});

describe("claim strategy", () => {
	it("scopes the claim to the resource, not the account", async () => {
		const { record } = await provisionFixture();
		expect(record.claim.strategy).toBe("resource-claim");
		expect(record.claim.boundary).toBe("resource");
		expect(record.claim.resourceKind).toBe("neon-project-database");
		expect(record.claim.atomicity).toBe("single-resource");
		expect(record.claim.state).toBe("unclaimed");
	});

	it("keeps the claim open on the rotation ceremony after the provider says CLAIMED", async () => {
		const { driver } = buildDriver([
			{ status: 200, body: fixture("get-database.claimed.json") },
		]);
		const record = await driver.observe({
			databaseId: FIXTURE_DATABASE_ID,
			resourceRef: "hobo://yard/demo/data/main",
		});

		expect(record.providerStatus).toBe("CLAIMED");
		expect(record.claim.state).toBe("claimed-pending-rotation");

		const verification = driver.verifyClaim(record);
		expect(verification.complete).toBe(false);
		expect(verification.blockingActions.map((action) => action.id)).toEqual([
			"neon.claim.rotate-owner-credentials",
		]);
	});

	it("only reports a complete claim once rotation is attested", async () => {
		const { driver } = buildDriver([
			{ status: 200, body: fixture("get-database.claimed.json") },
		]);
		const claimed = await driver.observe({
			databaseId: FIXTURE_DATABASE_ID,
			resourceRef: "hobo://yard/demo/data/main",
		});
		const rotated = driver.attestRotation(claimed, {
			rotatedAtMs: FIXTURE_NOW_MS + 60_000,
			attestedBy: "owner@example.test",
			evidenceRef: "hobo-secret://test-vault/neon/rotation-1#value",
		});
		expect(rotated.claim.state).toBe("complete");
		expect(driver.verifyClaim(rotated).complete).toBe(true);
	});

	it("refuses a rotation attestation before the provider reports CLAIMED", async () => {
		const { record } = await provisionFixture();
		const { driver } = buildDriver([]);
		try {
			driver.attestRotation(record, {
				rotatedAtMs: FIXTURE_NOW_MS,
				attestedBy: "owner@example.test",
				evidenceRef: "hobo-secret://test-vault/neon/rotation-1#value",
			});
			expect.unreachable("rotation before a claim must be refused");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as NeonProviderError).code).toBe("CLAIM_NOT_VERIFIED");
		}
	});
});

describe("observation and ownership", () => {
	it("preserves the earlier binding when the claimed record drops the connection string", async () => {
		const { record } = await provisionFixture();
		const { driver } = buildDriver([
			{ status: 200, body: fixture("get-database.claimed.json") },
		]);
		const observed = await driver.observe({
			databaseId: FIXTURE_DATABASE_ID,
			resourceRef: record.resourceRef,
			previous: record,
		});
		expect(observed.credentialRef).toBe(record.credentialRef);
		expect(observed.endpoints.pooled.host).toBe(record.endpoints.pooled.host);
	});

	it("rejects an observation whose project identity moved", async () => {
		const { record } = await provisionFixture();
		const body = {
			...parseJsonObject(fixture("get-database.claiming.json")),
			neon_project_id: "fake-project-99999999",
		};
		const { driver } = buildDriver([
			{ status: 200, body: JSON.stringify(body) },
		]);
		await expect(
			driver.observe({
				databaseId: FIXTURE_DATABASE_ID,
				resourceRef: record.resourceRef,
				previous: record,
			}),
		).rejects.toMatchObject({ code: "PROVISIONING_CONFLICT" });
	});

	it("does not consider control-plane self-assertion sufficient for ownership", async () => {
		const custody = createStubCustody();
		const clock = fixedClock(FIXTURE_NOW_MS);
		const client = createNeonClient({
			transport: createStubTransport([
				{ status: 200, body: fixture("create-database.unclaimed.json") },
				{ status: 200, body: fixture("create-database.unclaimed.json") },
			]),
			store: createInMemoryIdempotencyStore(),
			clock,
		});
		const driver = createNeonClaimableDatabaseDriver({
			client,
			custody,
			clock,
		});
		const record = await driver.provision({
			ref: "hobo-test",
			idempotencyKey: "hobo:resource:demo-db:0001",
			resourceRef: "hobo://yard/demo/data/main",
		});

		const verification = await driver.verifyOwnership(record);
		expect(verification.verified).toBe(false);
		expect(verification.reasons.join(" ")).toMatch(/independent/u);
	});

	it("verifies ownership when an independent data-plane probe agrees", async () => {
		const custody = createStubCustody();
		const clock = fixedClock(FIXTURE_NOW_MS);
		const client = createNeonClient({
			transport: createStubTransport([
				{ status: 200, body: fixture("create-database.unclaimed.json") },
				{ status: 200, body: fixture("create-database.unclaimed.json") },
			]),
			store: createInMemoryIdempotencyStore(),
			clock,
		});
		const probe: OwnershipProbePort = {
			async probe() {
				return {
					currentDatabase: "neondb",
					currentUser: "neondb_owner",
					systemIdentifier: "7000000000000000000",
					observedAtMs: FIXTURE_NOW_MS,
				};
			},
		};
		const driver = createNeonClaimableDatabaseDriver({
			client,
			custody,
			clock,
			probe,
		});
		const record = await driver.provision({
			ref: "hobo-test",
			idempotencyKey: "hobo:resource:demo-db:0001",
			resourceRef: "hobo://yard/demo/data/main",
		});
		const verification = await driver.verifyOwnership(record);
		expect(verification.verified).toBe(true);
		expect(verification.signals.map((signal) => signal.id)).toEqual([
			"control-plane-reread",
			"endpoint-continuity",
			"data-plane-probe",
		]);
	});
});

describe("lease", () => {
	it("raises LEASE_EXPIRED once the provider expiry has passed", async () => {
		const nowMs = Date.parse("2026-08-12T00:00:00.000Z");
		const { record } = await provisionFixture({ nowMs });
		const { driver } = buildDriver([], { nowMs });
		try {
			driver.assertLeaseLive(record);
			expect.unreachable("an expired lease must throw");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as NeonProviderError).code).toBe("LEASE_EXPIRED");
		}
	});

	it("does not expire a claimed database", async () => {
		const nowMs = Date.parse("2026-08-12T00:00:00.000Z");
		const { driver } = buildDriver(
			[{ status: 200, body: fixture("get-database.claimed.json") }],
			{
				nowMs,
			},
		);
		const record = await driver.observe({
			databaseId: FIXTURE_DATABASE_ID,
			resourceRef: "hobo://yard/demo/data/main",
		});
		expect(() => {
			driver.assertLeaseLive(record);
		}).not.toThrow();
	});
});
