import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ResourceLifecycleObservationRecordSchema } from "../src/_generated/resource_lifecycle_pb.js";
import {
	type ClaimableOperationKeyDeriver,
	claimableOperationKey,
	createClaimableOperationKeyDeriver,
	createClaimableResourceResolver,
	type ResourceRecordRepository,
} from "../src/ports/claimable-resolver.js";
import type {
	ResourceLifecycleObservation,
	ResourceMutationJournal,
} from "../src/ports/resource-lifecycle.js";
import {
	RESOLVER_CONTRACT,
	type ResolveOutcome,
	type ResolveRequest,
} from "../src/ports/resource-resolver.js";

const request: ResolveRequest = {
	ref: {
		slot: "data",
		productId: "example.database/v1",
		logicalId: "database",
	},
	desired: { idempotencyKey: "author-intent" },
	credentialRef: "vault://anonymous/no-account",
};
const scope = {
	tenantId: "tenant",
	providerAccountId: "anonymous",
	scopeId: "deployment-1",
};
const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const derive = createClaimableOperationKeyDeriver(keyBytes);
const operationKey = (...args: Parameters<ClaimableOperationKeyDeriver>) =>
	claimableOperationKey(args[0], args[1], derive);

const created: ResolveOutcome = {
	contract: RESOLVER_CONTRACT,
	action: "create",
	physicalId: "native-1",
	outputs: {
		endpointHost: "db.example.test",
		claimRef: "vault://claim/deployment-1",
		ready: true,
		operationConfirmed: true,
	},
	diagnostics: [],
};
const transport = async () => {
	throw new Error("unexpected transport");
};

function harness() {
	const records = new Map<string, ResolveOutcome>();
	const observations = new Map<string, ResourceLifecycleObservation>();
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
			records.set(key, value);
		},
		async readObservation(key) {
			return observations.get(key);
		},
		async writeObservation(key, value) {
			observations.set(key, value);
		},
	};
	const journal: ResourceMutationJournal = {
		persistence: "durable-cas",
		async claim(input) {
			const old = claims.get(input.mutationId);
			if (old) {
				if (old.requestDigest !== input.requestDigest)
					throw new Error("intent changed");
				return { status: old.status === "claimed" ? "uncertain" : old.status };
			}
			claims.set(input.mutationId, { ...input, status: "claimed" });
			return { status: "claimed" };
		},
		async acknowledge(id, digest) {
			claims.set(id, { requestDigest: digest, status: "acknowledged" });
		},
		async uncertain(id, digest) {
			claims.set(id, { requestDigest: digest, status: "uncertain" });
		},
	};
	let allocations = 0;
	const options = {
		providerId: "example",
		productId: request.ref.productId,
		scope,
		repository,
		journal,
		clock: () => 1000,
		async provision() {
			allocations++;
			return created;
		},
		async observe() {
			return { ...created, action: "adopt" as const };
		},
	};
	return { options, records, claims, allocations: () => allocations };
}

describe("claimable resolver custody", () => {
	it("shares once-only intent across competing reconciles and returns the persisted allocation", async () => {
		const h = harness();
		const resolver = createClaimableResourceResolver(h.options);
		const attempts = await Promise.allSettled([
			resolver.reconcile(request, transport),
			resolver.reconcile(request, transport),
		]);
		expect(h.allocations()).toBe(1);
		expect(
			attempts.filter((r) => r.status === "fulfilled").length,
		).toBeGreaterThan(0);
		expect((await resolver.reconcile(request, transport)).physicalId).toBe(
			"native-1",
		);
		expect(h.allocations()).toBe(1);
	});
	it("retains uncertain allocation after a lost reply and refuses blind recreate", async () => {
		const h = harness();
		let effects = 0;
		const resolver = createClaimableResourceResolver({
			...h.options,
			async provision() {
				effects++;
				throw new Error("reply lost after allocation");
			},
		});
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			"reply lost",
		);
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			"re-creation is forbidden",
		);
		expect(effects).toBe(1);
	});
	it("rejects changed intent and a foreign pinned physical id before another allocation", async () => {
		const h = harness();
		const resolver = createClaimableResourceResolver(h.options);
		await resolver.reconcile(request, transport);
		await expect(
			resolver.reconcile(
				{ ...request, desired: { idempotencyKey: "different" } },
				transport,
			),
		).rejects.toThrow("intent changed");
		if (!resolver.read)
			throw new Error("claimable resolver must implement read");
		await expect(
			resolver.read(
				{ ...request, ref: { ...request.ref, physicalId: "foreign" } },
				transport,
			),
		).rejects.toThrow("physical identity");
		expect(h.allocations()).toBe(1);
	});
	it("journals retirement once, preserves the evidence timestamp and refuses resurrection or stale proof", async () => {
		const h = harness();
		let nowMs = 1000;
		let retireCalls = 0;
		const resolver = createClaimableResourceResolver({
			...h.options,
			clock: () => nowMs,
			async retire(_request, initial, context) {
				retireCalls++;
				return create(ResourceLifecycleObservationRecordSchema, {
					tenantId: context.tenantId,
					providerId: context.providerId,
					providerAccountId: context.providerAccountId,
					productId: context.productId,
					resourceId: context.resourceId,
					operationId: context.operationId,
					physicalId: initial.physicalId,
					status: "absent",
					observedAtMs: 1000,
					evidenceRef: "native://example/retirement",
					operationTerminal: true,
					usageFinal: true,
					settledMicros: 3,
					usageEvidenceRef: "billing://example/final",
				});
			},
		});
		await resolver.reconcile(request, transport);
		await expect(
			resolver.delete(
				{ ...request, desired: { idempotencyKey: "changed" } },
				transport,
			),
		).rejects.toThrow("intent changed");
		expect(retireCalls).toBe(0);
		await resolver.delete(request, transport);
		await resolver.delete(request, transport);
		expect(retireCalls).toBe(1);
		nowMs = 1100;
		if (!resolver.read)
			throw new Error("claimable resolver must implement read");
		const observed = await resolver.read(request, transport);
		expect(observed?.outputs.absenceConfirmed).toBe(true);
		expect(observed?.outputs.observedAtMs).toBe(1000);
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			"resurrection is forbidden",
		);
		expect(h.allocations()).toBe(1);
		nowMs = 100000;
		await expect(resolver.read(request, transport)).rejects.toThrow("stale");
	});
	it("does not repeat a destructive retirement after its acknowledgement is lost", async () => {
		const h = harness();
		let retireCalls = 0;
		const resolver = createClaimableResourceResolver({
			...h.options,
			async retire() {
				retireCalls++;
				throw new Error("retirement reply lost");
			},
		});
		await resolver.reconcile(request, transport);
		await expect(resolver.delete(request, transport)).rejects.toThrow(
			"reply lost",
		);
		await expect(resolver.delete(request, transport)).rejects.toThrow(
			"destructive replay is forbidden",
		);
		expect(retireCalls).toBe(1);
	});
	it("separates provider idempotency keys across tenants, accounts, incarnations and logical resources", async () => {
		const first = await operationKey(scope, request);
		expect(first).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		);
		const values = await Promise.all([
			operationKey({ ...scope, tenantId: "other" }, request),
			operationKey({ ...scope, providerAccountId: "other" }, request),
			operationKey({ ...scope, scopeId: "next" }, request),
			operationKey(scope, {
				...request,
				ref: { ...request.ref, logicalId: "other" },
			}),
		]);
		expect(new Set([first, ...values]).size).toBe(5);
	});
	it("requires a private host key and snapshots its bytes before asynchronous crypto", async () => {
		expect(() =>
			createClaimableOperationKeyDeriver(new Uint8Array(31)),
		).toThrow("256");
		const mutable = new Uint8Array(keyBytes);
		const captured = createClaimableOperationKeyDeriver(mutable);
		mutable.fill(0);
		expect(await captured(scope, request)).toBe(await derive(scope, request));
		const different = createClaimableOperationKeyDeriver(
			Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
		);
		expect(await different(scope, request)).not.toBe(
			await derive(scope, request),
		);
		await expect(
			// @ts-expect-error JavaScript callers must also supply private key derivation.
			claimableOperationKey(scope, request),
		).rejects.toThrow("private host-backed");
		const rejected = claimableOperationKey(scope, request, async () => {
			throw new Error("native-capability-and-private-host-secret");
		});
		await expect(rejected).rejects.toThrow(
			"private operation-key derivation is unavailable",
		);
		await expect(rejected).rejects.not.toHaveProperty("cause");
	});
	it("refuses a changed private-key binding after an uncertain allocation", async () => {
		const h = harness();
		let fingerprint = "key-version-one";
		let effects = 0;
		const resolver = createClaimableResourceResolver({
			...h.options,
			async bindingFingerprint() {
				return fingerprint;
			},
			async provision() {
				effects++;
				throw new Error("reply lost");
			},
		});
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			"reply lost",
		);
		fingerprint = "key-version-two";
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			"intent changed",
		);
		expect(effects).toBe(1);
	});

	it("does not infer retirement from expiry or from a missing ownership record", async () => {
		const h = harness();
		const resolver = createClaimableResourceResolver(h.options);
		await expect(resolver.delete(request, transport)).rejects.toThrow(
			"ownership record",
		);
		await resolver.reconcile(request, transport);
		await expect(resolver.delete(request, transport)).rejects.toThrow(
			"expiry alone",
		);
	});
	it("refuses a secret-bearing provider outcome before persistence", async () => {
		const h = harness();
		const resolver = createClaimableResourceResolver({
			...h.options,
			async provision() {
				return { ...created, outputs: { password: "must-not-persist" } };
			},
		});
		await expect(resolver.reconcile(request, transport)).rejects.toThrow(
			"credential",
		);
		expect(h.records.size).toBe(0);
	});
});
