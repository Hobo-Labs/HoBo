import { parseSecretRef, type SecretRef, SecretValue } from "@hobo/bindings";
import {
	claimableOperationKey,
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
	createUpstashClient,
} from "../src/client.js";
import type { SecretCustodyPort, SecretCustodyScope } from "../src/custody.js";
import { createUpstashTemporaryRedisDriver } from "../src/driver.js";
import { createUpstashTemporaryRedisResolver } from "../src/resolver.js";
import {
	createStubCustody,
	createStubTransport,
	FAKE_DATABASE_ID,
	FAKE_REST_TOKEN,
	FIXTURE_CREATED_AT_MS,
	VALID_PAYLOAD,
} from "./fixtures/index.js";

const scope = {
	tenantId: "tenant",
	providerAccountId: "anonymous",
	scopeId: "deployment-incarnation",
};
const hostKey = () => Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const clock = () => FIXTURE_CREATED_AT_MS + 60_000;
const unusedTransport: HttpTransport = async () => {
	throw new Error("shipped driver owns its native HTTP boundary");
};
const request: ResolveRequest = {
	ref: {
		slot: "kv",
		productId: "upstash.temporary-redis/v1",
		logicalId: "redis",
	},
	desired: { idempotencyKey: "public-author-key" },
	credentialRef: "vault://host/private-key",
};

// Single-process fixture ports isolate the SDK boundary. The host's real SQLite
// race/reopen suites separately establish durable repository/journal behavior.
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
function fixtureVault() {
	const base = createStubCustody();
	const scopes: SecretCustodyScope[] = [];
	const custody: SecretCustodyPort = {
		async deposit(value, secretScope) {
			scopes.push(structuredClone(secretScope));
			return base.deposit(value, secretScope);
		},
	};
	const secretResolver = {
		async resolve(ref: SecretRef) {
			const value = base.deposited.get(ref);
			if (value === undefined) throw new Error("unknown fixture secret ref");
			return new SecretValue(parseSecretRef(ref), value);
		},
	};
	return { custody, secretResolver, scopes };
}
async function assemble(
	ports: ReturnType<typeof fixturePorts>,
	vault: ReturnType<typeof fixtureVault>,
	options: {
		readonly key?: Uint8Array;
		readonly readOnly?: boolean;
		readonly failNative?: boolean;
		readonly failCustody?: boolean;
	} = {},
) {
	const deriveOperationKey = createClaimableOperationKeyDeriver(
		options.key ?? hostKey(),
	);
	const nativeKey = await claimableOperationKey(
		scope,
		request,
		deriveOperationKey,
	);
	const metrics = {
		status: 200,
		body: '{"uptime_seconds":12,"commands_total":1}',
	};
	const transport = createStubTransport({
		script: options.readOnly
			? [metrics]
			: [
					{
						status: 200,
						body: VALID_PAYLOAD.replaceAll(FAKE_DATABASE_ID, nativeKey),
					},
					metrics,
				],
		...(options.failNative
			? { throws: [new Error(`native request exposed ${nativeKey}`)] }
			: undefined),
	});
	const custody: SecretCustodyPort = options.failCustody
		? {
				async deposit() {
					throw new Error(`custody exposed ${nativeKey}`);
				},
			}
		: vault.custody;
	const driver = createUpstashTemporaryRedisDriver({
		client: createUpstashClient({
			transport,
			store: createInMemoryIdempotencyStore(),
			clock,
			maxReadAttempts: 1,
		}),
		custody,
		clock,
	});
	const resolver = createUpstashTemporaryRedisResolver({
		scope,
		driver,
		custody,
		secretResolver: vault.secretResolver,
		deriveOperationKey,
		repository: ports.repository,
		journal: ports.journal,
		clock,
	});
	return { resolver, transport, nativeKey };
}
async function rejectedPublicError(run: () => Promise<ResolveOutcome>) {
	try {
		await run();
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("expected provider refusal");
}

describe("Upstash resolver shipped driver composition", () => {
	it("creates once, reads through GET metrics after a fresh driver/cache, and publishes only opaque custody handles", async () => {
		const ports = fixturePorts(),
			vault = fixtureVault();
		const first = await assemble(ports, vault);
		const allocated = await first.resolver.reconcile(request, unusedTransport);
		expect(first.transport.requests.map((row) => row.method)).toEqual(["POST"]);
		expect(first.transport.requests[0]?.headers["idempotency-key"]).toBe(
			first.nativeKey,
		);
		expect(allocated.physicalId).toMatch(/^claimable:[a-f0-9]{64}$/u);
		expect(allocated.physicalId).not.toBe(first.nativeKey);
		expect(allocated.outputs.ready).toBe(true);
		const restarted = await assemble(ports, vault, { readOnly: true });
		const recovered = await restarted.resolver.reconcile(
			request,
			unusedTransport,
		);
		expect(recovered.physicalId).toBe(allocated.physicalId);
		expect(restarted.transport.requests.map((row) => row.method)).toEqual([
			"GET",
		]);
		expect(restarted.transport.requests[0]?.url).toBe(
			`https://upstash.com/start-redis/metrics/${first.nativeKey}`,
		);
		const publicData = JSON.stringify({
			records: [...ports.records.values()],
			claims: [...ports.claims.values()],
			custodyScopes: vault.scopes,
		});
		expect(publicData).not.toContain(first.nativeKey);
		expect(publicData).not.toContain(first.nativeKey.replaceAll("-", ""));
		expect(publicData).not.toContain(FAKE_REST_TOKEN);
		expect(publicData).not.toContain("start-redis/console");
		expect(publicData).not.toContain("start-redis/metrics");
		expect(
			vault.scopes.some((row) => row.purpose === "native-resource-id"),
		).toBe(true);
	});
	it("refuses a changed host secret before another provider request", async () => {
		const ports = fixturePorts(),
			vault = fixtureVault();
		const first = await assemble(ports, vault);
		await first.resolver.reconcile(request, unusedTransport);
		const changed = await assemble(ports, vault, {
			key: Uint8Array.from({ length: 32 }, (_, index) => 255 - index),
		});
		await expect(
			changed.resolver.reconcile(request, unusedTransport),
		).rejects.toThrow("intent changed");
		expect(changed.transport.requests).toHaveLength(0);
	});
	it.each([
		"native",
		"custody",
	] as const)("masks capability-bearing %s errors and never persists a partial public record", async (failure) => {
		const ports = fixturePorts();
		const built = await assemble(ports, fixtureVault(), {
			failNative: failure === "native",
			failCustody: failure === "custody",
		});
		const error = await rejectedPublicError(() =>
			built.resolver.reconcile(request, unusedTransport),
		);
		expect(error.message).toContain("native capability details are private");
		expect(error.message).not.toContain(built.nativeKey);
		expect(error.stack).not.toContain(built.nativeKey);
		expect(error.cause).toBeUndefined();
		expect(ports.records.size).toBe(0);
	});
	it("refuses a native cache classified as public before issuing any HTTP request", () => {
		const transport = createStubTransport({}),
			store = createInMemoryIdempotencyStore();
		Object.defineProperty(store, "visibility", { value: "public-events" });
		expect(() => createUpstashClient({ transport, store, clock })).toThrow(
			"private custody",
		);
		expect(transport.requests).toHaveLength(0);
	});
});
