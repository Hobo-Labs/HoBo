import { describe, expect, it } from "vitest";

import {
	createInMemoryIdempotencyStore,
	createPrismaClient,
} from "../src/client.js";
import {
	createPrismaClaimableDatabaseDriver,
	type PrismaClaimableDatabase,
} from "../src/driver.js";
import type { PrismaProviderError } from "../src/errors.js";
import { parseJsonObject } from "../src/json.js";
import {
	createStubCustody,
	createStubRunner,
	FIXTURE_NOW_MS,
	fixedClock,
	fixture,
	stdout,
} from "./harness.js";

const RESOURCE_REF = "hobo://camp/dev/bindle/app-db";
const KEY = "hobo-prisma-driver-0001";

function harness(
	options: {
		readonly steps?: readonly ReturnType<typeof stdout>[];
		readonly nowMs?: number;
	} = {},
) {
	const runner = createStubRunner(
		options.steps ?? [stdout(fixture("create.success.json"))],
	);
	const custody = createStubCustody();
	const clock = fixedClock(options.nowMs ?? FIXTURE_NOW_MS);
	const client = createPrismaClient({
		runner,
		store: createInMemoryIdempotencyStore(),
		clock,
	});
	const driver = createPrismaClaimableDatabaseDriver({
		client,
		custody,
		clock,
	});
	return { runner, custody, driver, client };
}

async function provision(): Promise<{
	readonly record: PrismaClaimableDatabase;
	readonly custody: ReturnType<typeof createStubCustody>;
	readonly driver: ReturnType<typeof createPrismaClaimableDatabaseDriver>;
}> {
	const { custody, driver } = harness();
	const record = await driver.provision({
		idempotencyKey: KEY,
		resourceRef: RESOURCE_REF,
	});
	return { record, custody, driver };
}

describe("provision", () => {
	it("deposits the connection string and lets only the ref out", async () => {
		const { record, custody } = await provision();

		expect(custody.deposits).toHaveLength(1);
		expect(custody.deposits[0]?.scope.purpose).toBe("connection-string");
		expect(record.credentialRef).toMatch(/^hobo-secret:\/\//u);
		expect(JSON.stringify(record)).not.toContain("REDACTED");
		expect(JSON.stringify(record)).not.toContain("postgresql://");
	});

	it("keeps the endpoint as bare non-secret metadata", async () => {
		const { record } = await provision();
		expect(record.endpoint).toEqual({
			host: "db.prisma.io",
			port: 5432,
			path: "/postgres",
			tls: true,
		});
	});

	it("labels the expiry as CLI-local rather than provider-attested", async () => {
		const { record } = await provision();
		expect(record.expirySource).toBe("cli-local-clock");
		expect(record.expiresAtIso).toBe("2026-08-09T13:00:00.000Z");
		expect(record.documentedTtlHours).toBe(24);
	});

	it("emits a binding.postgresql/v1 binding that declares rotation unsupported", async () => {
		const { record } = await provision();
		expect(record.binding?.bindingProfileRef).toBe("binding.postgresql/v1");
		expect(record.binding?.capabilityProfileRef).toBe("data.postgres/v1");
		expect(record.binding?.rotationSupported).toBe(false);
	});

	it("refuses a connection string pointing away from the official database host", async () => {
		const body = {
			...parseJsonObject(fixture("create.success.json")),
			connectionString:
				"postgresql://fake_user_000000:REDACTED@db.prisma.io.attacker.example:5432/postgres",
		};
		const { driver } = harness({ steps: [stdout(JSON.stringify(body))] });

		try {
			await driver.provision({
				idempotencyKey: KEY,
				resourceRef: RESOURCE_REF,
			});
			expect.unreachable("an off-host connection string must be refused");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe(
				"PROVIDER_CONTRACT_CHANGED",
			);
		}
	});
});

describe("claim", () => {
	it("starts unclaimed with both ceremonies blocking", async () => {
		const { record, driver } = await provision();
		const verification = driver.verifyClaim(record);

		expect(record.claim.state).toBe("unclaimed");
		expect(verification.complete).toBe(false);
		expect(verification.blockingActions.map((action) => action.id)).toEqual([
			"prisma.claim.transfer-to-workspace",
			"prisma.claim.rotate-owner-credentials",
		]);
	});

	it("does not mark the claim complete after the workspace transfer alone", async () => {
		const { record, driver } = await provision();
		const claimed = driver.attestClaim(record, {
			claimedAtMs: FIXTURE_NOW_MS,
			attestedBy: "operator@example.test",
			workspaceId: "ws_fake",
		});

		expect(claimed.claim.state).toBe("claimed-pending-rotation");
		expect(driver.verifyClaim(claimed).complete).toBe(false);
		expect(
			driver.verifyClaim(claimed).blockingActions.map((action) => action.id),
		).toEqual(["prisma.claim.rotate-owner-credentials"]);
	});

	it("completes only once the owner credential rotation is attested", async () => {
		const { record, driver } = await provision();
		const claimed = driver.attestClaim(record, {
			claimedAtMs: FIXTURE_NOW_MS,
			attestedBy: "operator@example.test",
			workspaceId: "ws_fake",
		});
		const rotated = driver.attestRotation(claimed, {
			rotatedAtMs: FIXTURE_NOW_MS + 1_000,
			attestedBy: "operator@example.test",
			evidenceRef: "hobo.evidence/rotation/1",
		});

		expect(rotated.claim.state).toBe("complete");
		expect(driver.verifyClaim(rotated).complete).toBe(true);
	});

	it("refuses to attest rotation before the transfer", async () => {
		const { record, driver } = await provision();
		expect(() =>
			driver.attestRotation(record, {
				rotatedAtMs: FIXTURE_NOW_MS,
				attestedBy: "operator@example.test",
				evidenceRef: "hobo.evidence/rotation/1",
			}),
		).toThrowError(/only be attested after the workspace transfer/u);
	});

	it("raises LEASE_EXPIRED once the CLI-computed deadline has passed", async () => {
		const { driver } = harness();
		const record = await driver.provision({
			idempotencyKey: KEY,
			resourceRef: RESOURCE_REF,
		});
		const later = createPrismaClaimableDatabaseDriver({
			client: createPrismaClient({
				runner: createStubRunner([]),
				store: createInMemoryIdempotencyStore(),
				clock: fixedClock(record.expiresAtMs + 1),
			}),
			custody: createStubCustody(),
			clock: fixedClock(record.expiresAtMs + 1),
		});

		expect(() => later.assertLeaseLive(record)).toThrowError(/lease lapsed/u);
	});
});

describe("associatedResource", () => {
	it("exposes the typed reference a bundled claim strategy needs", async () => {
		const { record, driver } = await provision();
		const associated = driver.associatedResource(record);

		expect(associated).toMatchObject({
			schemaVersion: "hobo.provider-prisma-postgres.associated-resource/v1",
			kind: "prisma-postgres-project",
			providerId: "prisma",
			projectId: "proj_fake000000000000",
			claimHost: "create-db.prisma.io",
			standaloneClaimSupported: true,
			requiresWorkspace: true,
			bundleStrategy: "associated-resource",
			expirySource: "cli-local-clock",
		});
	});

	it("carries no credential material, so a bundler may persist it", async () => {
		const { record, driver } = await provision();
		const serialized = JSON.stringify(driver.associatedResource(record));
		expect(serialized).not.toMatch(/postgres(?:ql)?:\/\//u);
		expect(serialized).not.toContain("REDACTED");
	});
});

describe("verifyOwnership", () => {
	it("fails closed and names the missing control-plane API", async () => {
		const { record, driver } = await provision();
		const verification = await driver.verifyOwnership(record);

		expect(verification.verified).toBe(false);
		expect(verification.reasons.join(" ")).toContain("no provider read API");
	});

	it("passes only on an independent data-plane probe agreeing with the record", async () => {
		const runner = createStubRunner([stdout(fixture("create.success.json"))]);
		const custody = createStubCustody();
		const clock = fixedClock(FIXTURE_NOW_MS);
		const driver = createPrismaClaimableDatabaseDriver({
			client: createPrismaClient({
				runner,
				store: createInMemoryIdempotencyStore(),
				clock,
			}),
			custody,
			clock,
			probe: {
				async probe() {
					return {
						currentDatabase: "postgres",
						currentUser: "fake_user_000000",
						systemIdentifier: "7000000000000000000",
						observedAtMs: FIXTURE_NOW_MS,
					};
				},
			},
		});
		const record = await driver.provision({
			idempotencyKey: KEY,
			resourceRef: RESOURCE_REF,
		});

		const verification = await driver.verifyOwnership(record);
		expect(verification.verified).toBe(true);
		expect(
			verification.signals.find((signal) => signal.id === "data-plane-probe")
				?.independent,
		).toBe(true);
	});

	it("fails when the data plane reports a different database", async () => {
		const runner = createStubRunner([stdout(fixture("create.success.json"))]);
		const custody = createStubCustody();
		const clock = fixedClock(FIXTURE_NOW_MS);
		const driver = createPrismaClaimableDatabaseDriver({
			client: createPrismaClient({
				runner,
				store: createInMemoryIdempotencyStore(),
				clock,
			}),
			custody,
			clock,
			probe: {
				async probe() {
					return {
						currentDatabase: "someone_elses_db",
						currentUser: "fake_user_000000",
						systemIdentifier: "7000000000000000001",
						observedAtMs: FIXTURE_NOW_MS,
					};
				},
			},
		});
		const record = await driver.provision({
			idempotencyKey: KEY,
			resourceRef: RESOURCE_REF,
		});

		const verification = await driver.verifyOwnership(record);
		expect(verification.verified).toBe(false);
		expect(verification.reasons.join(" ")).toContain(
			"data-plane probe disagrees",
		);
	});
});
