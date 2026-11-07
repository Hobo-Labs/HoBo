/**
 * `observe`, `rotateBinding`, and `destroy`.
 *
 * All three are shaped by one provider fact: `create-db` can create a database
 * and nothing else. There is no read, no rotate, and no delete. These tests
 * exist to keep that honesty from eroding into a comfortable lie the first time
 * a caller wants `destroy()` to return `true`.
 */

import { create } from "@bufbuild/protobuf";
import { ResourceLifecycleObservationRecordSchema } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createInMemoryIdempotencyStore,
	createPrismaClient,
} from "../src/client.js";
import {
	createPrismaClaimableDatabaseDriver,
	type PrismaClaimableDatabase,
	type PrismaDriverOptions,
} from "../src/driver.js";
import type { PrismaProviderError } from "../src/errors.js";
import {
	createStubCustody,
	createStubRunner,
	FIXTURE_NOW_MS,
	fixedClock,
	fixture,
	stdout,
} from "./harness.js";

const RESOURCE_REF = "hobo://camp/dev/bindle/app-db";
const KEY = "hobo-prisma-lifecycle-0001";

function harness(nowMs: number = FIXTURE_NOW_MS) {
	const runner = createStubRunner([stdout(fixture("create.success.json"))]);
	const custody = createStubCustody();
	const store = createInMemoryIdempotencyStore();
	const clock = fixedClock(nowMs);
	const client = createPrismaClient({ runner, store, clock });
	const driver = createPrismaClaimableDatabaseDriver({
		client,
		custody,
		clock,
	});
	return { runner, custody, store, client, driver, clock };
}

/** Same journal, a driver whose clock has moved on. */
function driverAt(
	nowMs: number,
	client: ReturnType<typeof createPrismaClient>,
	revocation?: { revoke(ref: string): Promise<void> },
	retirement?: PrismaDriverOptions["retirement"],
) {
	return createPrismaClaimableDatabaseDriver({
		client,
		custody: createStubCustody(),
		clock: fixedClock(nowMs),
		retirement,
		...(revocation !== undefined
			? {
					revocation: { revoke: async (ref: string) => revocation.revoke(ref) },
				}
			: undefined),
	});
}

async function provisioned(): Promise<{
	readonly record: PrismaClaimableDatabase;
	readonly client: ReturnType<typeof createPrismaClient>;
	readonly driver: ReturnType<typeof createPrismaClaimableDatabaseDriver>;
}> {
	const { driver, client } = harness();
	const record = await driver.provision({
		idempotencyKey: KEY,
		resourceRef: RESOURCE_REF,
	});
	return { record, client, driver };
}

describe("observe", () => {
	it("reports a live record from the journal and says the evidence is local", async () => {
		const { driver } = await provisioned();
		const observation = await driver.observe({
			idempotencyKey: KEY,
			resourceRef: RESOURCE_REF,
		});

		expect(observation.kind).toBe("live");
		expect(observation.evidence).toBe("local-journal");
		if (observation.kind !== "live") throw new Error("unreachable");
		expect(observation.remainingMs).toBe(24 * 60 * 60 * 1000);
		expect(observation.record.projectId).toBe("proj_fake000000000000");
		expect(observation.record.adopted).toBe(true);
	});

	it("flips to expired once the CLI-computed deadline passes, without a provider call", async () => {
		const { record, client } = await provisioned();
		const later = driverAt(record.expiresAtMs + 5_000, client);

		const observation = await later.observe({
			idempotencyKey: KEY,
			resourceRef: RESOURCE_REF,
		});
		expect(observation.kind).toBe("expired");
		if (observation.kind !== "expired") throw new Error("unreachable");
		expect(observation.expiredForMs).toBe(5_000);
	});

	it("distinguishes an unresolved attempt from an unknown key", async () => {
		const store = createInMemoryIdempotencyStore([
			{
				key: "hobo-prisma-inflight-01",
				state: "in-flight",
				attemptedAtMs: FIXTURE_NOW_MS,
			},
		]);
		const client = createPrismaClient({
			runner: createStubRunner([]),
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});
		const driver = driverAt(FIXTURE_NOW_MS, client);

		const unresolved = await driver.observe({
			idempotencyKey: "hobo-prisma-inflight-01",
			resourceRef: RESOURCE_REF,
		});
		const absent = await driver.observe({
			idempotencyKey: "hobo-prisma-nothing-01",
			resourceRef: RESOURCE_REF,
		});

		expect(unresolved.kind).toBe("unresolved");
		expect(absent.kind).toBe("absent");
	});

	it("never runs the CLI", async () => {
		const { runner, driver } = harness();
		await driver.provision({ idempotencyKey: KEY, resourceRef: RESOURCE_REF });
		const before = runner.runs.length;
		await driver.observe({ idempotencyKey: KEY, resourceRef: RESOURCE_REF });
		expect(runner.runs.length).toBe(before);
	});

	it("refuses a journalled credential locator that is not a secret reference", async () => {
		const store = createInMemoryIdempotencyStore([
			{
				key: KEY,
				state: "created",
				attemptedAtMs: FIXTURE_NOW_MS,
				snapshot: {
					projectId: "proj_fake000000000000",
					claimUrl:
						"https://create-db.prisma.io/claim?projectID=proj_fake000000000000",
					region: "us-east-1",
					name: "2026-08-08T13:00:00.000Z",
					deletionDateIso: "2026-08-09T13:00:00.000Z",
					deletionDateMs: Date.parse("2026-08-09T13:00:00.000Z"),
					host: "db.prisma.io",
					port: 5432,
					databaseName: "postgres",
					tls: true,
					// Someone edited the journal and pasted the credential back.
					credentialRef:
						"postgresql://fake_user:REDACTED@db.prisma.io:5432/postgres",
				},
			},
		]);
		const client = createPrismaClient({
			runner: createStubRunner([]),
			store,
			clock: fixedClock(FIXTURE_NOW_MS),
		});
		const driver = driverAt(FIXTURE_NOW_MS, client);

		try {
			await driver.observe({ idempotencyKey: KEY, resourceRef: RESOURCE_REF });
			expect.unreachable("a journalled plaintext credential must be refused");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe(
				"SECRET_REFERENCE_INVALID",
			);
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).message).not.toContain("REDACTED");
		}
	});
});

describe("rotateBinding", () => {
	it("refuses, and points at the claim rather than pretending", async () => {
		const { record, driver } = await provisioned();
		try {
			await driver.rotateBinding(record);
			expect.unreachable("rotation is not available on the temporary tier");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe(
				"BINDING_ROTATION_REQUIRED",
			);
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).message).toContain(
				"no documented rotation surface",
			);
		}
	});

	it("leaks no credential into the refusal", async () => {
		const { record, driver } = await provisioned();
		await expect(driver.rotateBinding(record)).rejects.toSatisfy(
			(error: Error) => {
				const text = JSON.stringify(error.message);
				return (
					!/postgres(?:ql)?:\/\//u.test(text) && !text.includes("REDACTED")
				);
			},
		);
	});
});

describe("destroy", () => {
	it("requires fresh scoped terminal provider absence and final usage before release", async () => {
		const { record, client } = await provisioned();
		const context = {
			tenantId: "tenant",
			providerId: record.providerId,
			providerAccountId: "anonymous",
			productId: record.definitionId,
			resourceId: record.resourceRef,
			operationId: "retire:db",
			nowMs: FIXTURE_NOW_MS,
			maxAgeMs: 1000,
		};
		const later = driverAt(
			FIXTURE_NOW_MS,
			client,
			undefined,
			async (resource, scope) =>
				create(ResourceLifecycleObservationRecordSchema, {
					...scope,
					physicalId: resource.projectId,
					status: "absent",
					operationTerminal: true,
					observedAtMs: FIXTURE_NOW_MS,
					evidenceRef: "provider://retirement",
					usageFinal: true,
					usageEvidenceRef: "provider://final-usage",
					settledMicros: 0,
				}),
		);
		expect(await later.destroy(record, context)).toMatchObject({
			released: true,
			reapMode: "provider-confirmed",
		});
		const foreign = driverAt(
			FIXTURE_NOW_MS,
			client,
			undefined,
			async (resource, scope) =>
				create(ResourceLifecycleObservationRecordSchema, {
					...scope,
					physicalId: resource.projectId,
					tenantId: "foreign",
					status: "absent",
					operationTerminal: true,
					observedAtMs: FIXTURE_NOW_MS,
					evidenceRef: "provider://retirement",
					usageFinal: true,
					usageEvidenceRef: "provider://final-usage",
					settledMicros: 0,
				}),
		);
		await expect(foreign.destroy(record, context)).rejects.toThrow(/foreign/u);
	});
	it("reports the TTL reap rather than claiming a deletion it cannot perform", async () => {
		const { record, driver } = await provisioned();
		const outcome = await driver.destroy(record);

		expect(outcome.released).toBe(false);
		expect(outcome.reapMode).toBe("ttl-expiry");
		expect(outcome.expiresAtIso).toBe(record.expiresAtIso);
		expect(outcome.detail).toContain("no delete command exists");
	});

	it("does not release financial exposure when only the local deadline has passed", async () => {
		const { record, client } = await provisioned();
		const later = driverAt(record.expiresAtMs + 1, client);
		const outcome = await later.destroy(record);

		expect(outcome.released).toBe(false);
		expect(outcome.reapMode).toBe("already-expired");
	});

	it("revokes the deposited locator when a revocation port is configured", async () => {
		const { record, client } = await provisioned();
		const revoked: string[] = [];
		const driver = driverAt(FIXTURE_NOW_MS, client, {
			async revoke(ref) {
				revoked.push(ref);
			},
		});

		const outcome = await driver.destroy(record);
		expect(outcome.custodyRevoked).toBe(true);
		expect(revoked).toHaveLength(1);
		expect(revoked[0]).toMatch(/^hobo-secret:\/\//u);
	});

	it("fails with CLEANUP_FAILED when custody refuses to revoke", async () => {
		const { record, client } = await provisioned();
		const driver = driverAt(FIXTURE_NOW_MS, client, {
			async revoke() {
				throw new Error("vault offline");
			},
		});

		try {
			await driver.destroy(record);
			expect.unreachable("a failed revocation is a failed cleanup");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe("CLEANUP_FAILED");
		}
	});

	it("refuses to 'destroy' a claimed database, which nothing reaps", async () => {
		const { record, driver } = await provisioned();
		const claimed = driver.attestClaim(record, {
			claimedAtMs: FIXTURE_NOW_MS,
			attestedBy: "operator@example.test",
			workspaceId: "ws_fake",
		});

		try {
			await driver.destroy(claimed);
			expect.unreachable("a claimed database is no longer on a TTL");
		} catch (error) {
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).code).toBe("CLEANUP_FAILED");
			// SAFETY: value was established by the surrounding parse or typed constructor.
			expect((error as PrismaProviderError).message).toContain(
				"no longer auto-deleted",
			);
		}
	});
});
