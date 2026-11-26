import {
	createClaimableOperationKeyDeriver,
	type HttpTransport,
	type ResolveOutcome,
	type ResolveRequest,
	type ResourceMutationJournal,
	type ResourceRecordRepository,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createPrismaClient,
} from "../src/client.js";
import { createPrismaClaimableDatabaseDriver } from "../src/driver.js";
import { createPrismaClaimableResolver } from "../src/resolver.js";
import {
	createStubCustody,
	createStubRunner,
	FIXTURE_NOW_MS,
	FIXTURE_PROJECT_ID,
	fixture,
	stdout,
} from "./harness.js";

const scope = {
	tenantId: "tenant",
	providerAccountId: "anonymous",
	scopeId: "deployment-incarnation",
};
const hostKey = () => Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const unusedTransport: HttpTransport = async () => {
	throw new Error("shipped driver owns its process boundary");
};
const request: ResolveRequest = {
	ref: {
		slot: "data",
		productId: "prisma.claimable-postgres/v1",
		logicalId: "database",
	},
	desired: {
		idempotencyKey: "public-author-key",
		ttl: "24h",
		region: "us-east-1",
	},
	credentialRef: "vault://host/private-key",
};

// These fixture ports test provider composition, not persistence durability;
// the host's SQLite race/reopen suites validate the actual repository/journal.
function fixturePorts() {
	const records = new Map<string, ResolveOutcome>();
	const claims = new Map<
		string,
		{ requestDigest: string; status: "claimed" | "acknowledged" | "uncertain" }
	>();
	const repository: ResourceRecordRepository<ResolveOutcome> = {
		persistence: "durable-cas",
		async read(key) {
			return records.get(key);
		},
		async write(key, value) {
			if (records.has(key)) throw new Error("initial record is immutable");
			records.set(key, value);
		},
		async readObservation() {
			return undefined;
		},
		async writeObservation() {
			throw new Error("unexpected retirement");
		},
	};
	const journal: ResourceMutationJournal = {
		persistence: "durable-cas",
		async claim(input) {
			const prior = claims.get(input.mutationId);
			if (prior) {
				if (prior.requestDigest !== input.requestDigest)
					throw new Error("intent changed");
				return {
					status: prior.status === "claimed" ? "uncertain" : prior.status,
				};
			}
			claims.set(input.mutationId, {
				requestDigest: input.requestDigest,
				status: "claimed",
			});
			return { status: "claimed" };
		},
		async acknowledge(id, digest) {
			claims.set(id, { requestDigest: digest, status: "acknowledged" });
		},
		async uncertain(id, digest) {
			claims.set(id, { requestDigest: digest, status: "uncertain" });
		},
	};
	return { records, claims, repository, journal };
}

function assemble(
	ports: ReturnType<typeof fixturePorts>,
	custody: ReturnType<typeof createStubCustody>,
	key = hostKey(),
) {
	const runner = createStubRunner([stdout(fixture("create.success.json"))]);
	const clock = () => FIXTURE_NOW_MS;
	const driver = createPrismaClaimableDatabaseDriver({
		client: createPrismaClient({
			runner,
			store: createInMemoryIdempotencyStore(),
			clock,
		}),
		custody,
		clock,
	});
	const resolver = createPrismaClaimableResolver({
		scope,
		driver,
		custody,
		secretResolver: custody,
		deriveOperationKey: createClaimableOperationKeyDeriver(key),
		repository: ports.repository,
		journal: ports.journal,
		clock,
	});
	return { resolver, runner };
}

describe("Prisma resolver shipped driver composition", () => {
	it("runs the pinned native CLI once and recovers an opaque identity across a fresh driver/cache", async () => {
		const ports = fixturePorts(),
			custody = createStubCustody();
		const first = assemble(ports, custody);
		const allocated = await first.resolver.reconcile(request, unusedTransport);
		expect(first.runner.runs).toHaveLength(1);
		expect(first.runner.runs[0]?.argv).toContain("create-db@1.2.1");
		expect(first.runner.runs[0]?.argv).toContain("--region=us-east-1");
		expect(first.runner.runs[0]?.argv).toContain("--ttl=24h");
		expect(allocated.physicalId).toMatch(/^claimable:[a-f0-9]{64}$/u);
		expect(allocated.outputs.ready).toBe(false);
		expect(allocated.outputs.operationConfirmed).toBe(false);
		const restarted = assemble(ports, custody);
		const recovered = await restarted.resolver.reconcile(
			request,
			unusedTransport,
		);
		expect(recovered.physicalId).toBe(allocated.physicalId);
		expect(recovered.outputs.ready).toBe(false);
		expect(restarted.runner.runs).toHaveLength(0);
		const published = JSON.stringify({
			records: [...ports.records.values()],
			claims: [...ports.claims.values()],
			labels: custody.deposits,
		});
		expect(published).not.toContain(FIXTURE_PROJECT_ID);
		expect(published).not.toContain("create-db.prisma.io/claim");
		expect(published).not.toContain("postgresql://");
		expect(published).not.toContain("REDACTED");
		expect(
			custody.deposits.some(
				(row) => row.scope.purpose === "native-resource-id",
			),
		).toBe(true);
	});
	it("rejects unsupported region, TTL and metadata before journal claims or process launch", async () => {
		const ports = fixturePorts();
		const { resolver, runner } = assemble(ports, createStubCustody());
		for (const desired of [
			{ ...request.desired, region: "foreign-region" },
			{ ...request.desired, ttl: "999h" },
			{ ...request.desired, operationId: "injected" },
		])
			await expect(
				resolver.reconcile({ ...request, desired }, unusedTransport),
			).rejects.toThrow();
		expect(ports.claims.size).toBe(0);
		expect(runner.runs).toHaveLength(0);
		await resolver.reconcile(request, unusedTransport);
		expect(runner.runs).toHaveLength(1);
	});
	it("refuses private host-key rotation under an existing immutable allocation intent", async () => {
		const ports = fixturePorts(),
			custody = createStubCustody();
		const first = assemble(ports, custody);
		await first.resolver.reconcile(request, unusedTransport);
		const changed = assemble(
			ports,
			custody,
			Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
		);
		await expect(
			changed.resolver.reconcile(request, unusedTransport),
		).rejects.toThrow("intent changed");
		expect(changed.runner.runs).toHaveLength(0);
	});
	it("refuses a native idempotency cache classified as public before invoking a process", () => {
		const runner = createStubRunner([]),
			store = createInMemoryIdempotencyStore();
		Object.defineProperty(store, "visibility", { value: "public-events" });
		expect(() =>
			createPrismaClient({ runner, store, clock: () => FIXTURE_NOW_MS }),
		).toThrow("private custody");
		expect(runner.runs).toHaveLength(0);
	});
});
