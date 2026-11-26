import type {
	ResolveOutcome,
	ResourceLifecycleObservation,
	ResourceMutationJournal,
	ResourceRecordRepository,
} from "@hobo/core";
import { createClaimableOperationKeyDeriver } from "@hobo/core";
import { describe, expect, it } from "vitest";
import {
	createInMemoryIdempotencyStore,
	createNeonClient,
} from "../src/client.js";
import { createNeonClaimableDatabaseDriver } from "../src/driver.js";
import { createNeonClaimableResolver } from "../src/resolver.js";
import {
	createStubCustody,
	createStubTransport,
	FIXTURE_NOW_MS,
	fixture,
} from "./harness.js";

describe("Neon resolver actual driver composition", () => {
	it("performs one native allocation, then independently reads it; persisted outcomes contain custody locators", async () => {
		const transport = createStubTransport([
			{ status: 201, body: fixture("create-database.unclaimed.json") },
			{ status: 200, body: fixture("create-database.unclaimed.json") },
			{ status: 200, body: fixture("create-database.unclaimed.json") },
		]);
		const custody = createStubCustody();
		const clock = () => FIXTURE_NOW_MS;
		const driver = createNeonClaimableDatabaseDriver({
			client: createNeonClient({
				transport,
				store: createInMemoryIdempotencyStore(),
				clock,
			}),
			custody,
			clock,
		});
		const records = new Map<string, ResolveOutcome>();
		const repository: ResourceRecordRepository<ResolveOutcome> = {
			persistence: "durable-cas",
			async read(key) {
				return records.get(key);
			},
			async write(key, value) {
				records.set(key, value);
			},
			async readObservation() {
				return undefined;
			},
			async writeObservation(
				_key: string,
				_value: ResourceLifecycleObservation,
			) {
				throw new Error("unexpected retirement");
			},
		};
		const claims = new Map<string, string>();
		const journal: ResourceMutationJournal = {
			persistence: "durable-cas",
			async claim({ mutationId, requestDigest }) {
				const old = claims.get(mutationId);
				if (old && old !== requestDigest) throw new Error("intent changed");
				claims.set(mutationId, requestDigest);
				return { status: old ? "acknowledged" : "claimed" };
			},
			async acknowledge() {},
			async uncertain() {},
		};
		const configuration = {
			scope: {
				tenantId: "tenant",
				providerAccountId: "anonymous",
				scopeId: "deployment",
			},
			driver,
			custody,
			secretResolver: custody,
			deriveOperationKey: createClaimableOperationKeyDeriver(
				Uint8Array.from({ length: 32 }, (_, i) => i + 1),
			),
			repository,
			journal,
			clock,
		};
		const resolver = createNeonClaimableResolver(configuration);
		const request = {
			ref: {
				slot: "data" as const,
				productId: resolver.productId,
				logicalId: "database",
			},
			desired: { idempotencyKey: "author-key", ref: "hobo-validation" },
			credentialRef: "vault://anonymous/provider",
		};
		const unexpected = async () => {
			throw new Error("driver owns its native HTTP client");
		};
		await expect(
			resolver.reconcile(
				{ ...request, desired: { ...request.desired, unsupported: true } },
				unexpected,
			),
		).rejects.toThrow("unsupported desired fields");
		expect(claims.size).toBe(0);
		expect(transport.posts).toHaveLength(0);
		const created = await resolver.reconcile(request, unexpected);
		if (!resolver.read) throw new Error("Neon resolver must implement read");
		const read = await resolver.read(request, unexpected);
		expect(read?.physicalId).toBe(created.physicalId);
		expect(read?.outputs.ready).toBe(true);
		expect(transport.posts).toHaveLength(1);
		expect(transport.gets).toHaveLength(1);
		const restarted = createNeonClaimableResolver({
			...configuration,
			driver: createNeonClaimableDatabaseDriver({
				client: createNeonClient({
					transport,
					store: createInMemoryIdempotencyStore(),
					clock,
				}),
				custody,
				clock,
			}),
		});
		const recovered = await restarted.reconcile(request, unexpected);
		expect(recovered.physicalId).toBe(created.physicalId);
		expect(recovered.outputs.ready).toBe(true);
		expect(transport.posts).toHaveLength(1);
		expect(transport.gets).toHaveLength(2);
		const persisted = JSON.stringify([...records.values()]);
		expect(persisted).toContain("claimRef");
		expect(persisted).not.toContain("neon.new/claim");
		expect(persisted).not.toContain("REDACTED");
		expect(persisted).not.toContain("postgresql://");
		expect(persisted).not.toContain("01999999-0000-7000-8000-000000000001");
		expect(created.physicalId).toMatch(/^claimable:[a-f0-9]{64}$/u);
		expect(JSON.stringify(custody.deposits)).not.toContain(
			"01999999-0000-7000-8000-000000000001",
		);
		expect(
			custody.deposits.some((deposit) => deposit.scope.purpose === "claim-url"),
		).toBe(true);
		await expect(resolver.delete(request, unexpected)).rejects.toThrow(
			"no verified delete",
		);
	});
});
