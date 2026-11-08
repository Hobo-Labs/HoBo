import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@hobo/bindles";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createYardClient,
	type YardRuntime,
	type YardSession,
} from "../src/cloud/yard-client.js";
import { parseArgv } from "../src/shell/parse.js";

const dispose: (() => void)[] = [];
afterEach(() => {
	while (dispose.length) dispose.pop()?.();
});
const manifest = parseManifest({
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasm", version: "1" },
	resources: {
		app: {
			type: "component.v1",
			image: "oci://example/app",
			runtime: "wasm",
			exports: ["wasi:http/incoming-handler"],
		},
	},
});
const session: YardSession = {
	tenant: "tenant",
	principal: { kind: "user", id: "operator" },
	token: "fixture",
	issuedAt: new Date(1000).toISOString(),
};
function fixture() {
	const dataDir = mkdtempSync(join(tmpdir(), "cli-hosting-budget-"));
	const store = createRuntimeLocalEventStore({
		dataDir,
		clock: createManualClock(),
	});
	dispose.push(() => {
		store.close();
		rmSync(dataDir, { recursive: true, force: true });
	});
	let legacyWrites = 0,
		reservations = 0,
		supervised = 0,
		teardowns = 0;
	const authority: SharedHostingBudgetAuthority = {
		persistence: "durable-cas",
		resolve: async () => ({
			nowMs: 1000,
			horizonEndMs: 2000,
			maxObservationAgeMs: 1000,
			budget: {
				tenantId: "tenant",
				budgetId: "hosting",
				scopeId: "camp",
				periodId: "period",
				policyRevision: "r1",
				ledgerSeq: 0,
				currency: "USD",
				periodStartMs: 0,
				periodEndMs: 3000,
				capMicros: 100,
				settledMicros: 0,
				committedMicros: 0,
				unresolvedMicros: 0,
				recoveryReserveMicros: 0,
				observedAtMs: 1000,
				validUntilMs: 3000,
				providerAccountId: "",
			},
			quotes: [
				{
					id: "quote",
					resourceName: "app",
					definitionId: "host",
					providerId: "host",
					providerAccountId: "account",
					currency: "USD",
					rateMicros: 10,
					billingUnit: "request",
					billingPeriodMs: 0,
					source: "https://example.test/quote",
					observedAtMs: 1000,
					validUntilMs: 3000,
					liabilityEndsAtMs: 2000,
					entitlementId: "",
					minimumQuantity: 0,
					roundUpQuantity: false,
					fixedCostMicros: 0,
					transitionCostMicros: 0,
				},
			],
			usages: [
				{
					resourceName: "app",
					unit: "request",
					expectedQuantity: 1,
					boundedQuantity: 1,
				},
			],
			entitlements: [],
			providerBudgets: [],
		}),
		reserve: async (request) => {
			reservations++;
			return { ok: true, reservationId: request.reservationId };
		},
		lookup: async () => ({ status: "held", reservedMicros: 10 }),
		claimExecution: async () => ({ ok: true }),
		uncertain: async () => {},
		settle: async () => ({ ok: true }),
	};
	const runtime: YardRuntime = {
		store,
		actorHost: createInMemoryActorHost(),
		broker: createInProcessCredentialBroker(),
		executor: createInProcessExecutor({
			iac: {
				id: "legacy",
				preview: async () => ({ changes: 1, summary: "legacy" }),
				apply: async () => {
					legacyWrites++;
					return {};
				},
				destroy: async () => {
					legacyWrites++;
				},
				refresh: async () => ({ drift: false, observed: {} }),
			},
		}),
		registry: {
			catalogHash: "sha256:fixture",
			providers: () => ["host"],
			definitions: () => [
				{
					id: "host",
					providerId: "host",
					port: "compute",
					features: ["http"],
					regions: ["us"],
					specificity: 1,
					priority: 0,
					cost: { sku: "host", unit: "request", marginalPrice: "0.00001" },
					satisfies: () => ({ kind: "full" }),
				},
			],
		},
		hostingBudgetAuthority: authority,
		defaultHostingBudgetId: "hosting",
		hostingBudgetRequired: true,
		hostingExecution: {
			up: async ({ admission }) => {
				supervised++;
				return {
					status: "waiting",
					deploymentId: admission.deploymentId,
					planHash: admission.planHash,
					plan: admission.plan,
					provisioned: [],
					progress: [],
				};
			},
			down: async ({ deploymentId }) => {
				teardowns++;
				return {
					status: "needs-human",
					deploymentId,
					destroyed: [],
					progress: [],
				};
			},
		},
	};
	return {
		runtime,
		counts: () => ({ legacyWrites, reservations, supervised, teardowns }),
	};
}
describe("production CLI budget execution", () => {
	it("forwards authoritative admission to the supervisor without legacy provider effects", async () => {
		const fx = fixture();
		expect(
			(
				await createYardClient(fx.runtime).up(manifest, {
					deploymentId: "one",
					session,
				})
			).status,
		).toBe("waiting");
		expect(fx.counts()).toEqual({
			legacyWrites: 0,
			reservations: 1,
			supervised: 1,
			teardowns: 0,
		});
	});
	it("refuses a production path with no supervisor before reserving or applying", async () => {
		const fx = fixture(),
			{ hostingExecution: _removed, ...runtime } = fx.runtime;
		expect(
			(
				await createYardClient(runtime).up(manifest, {
					deploymentId: "one",
					session,
				})
			).status,
		).toBe("rejected");
		expect(fx.counts().reservations).toBe(0);
		expect(fx.counts().legacyWrites).toBe(0);
	});
	it("plans against trusted evidence without consuming a reservation", async () => {
		const fx = fixture();
		expect(
			(
				await createYardClient(fx.runtime).planAuthoritatively(manifest, {
					deploymentId: "one",
					session,
				})
			).ok,
		).toBe(true);
		expect(fx.counts().reservations).toBe(0);
	});
	it("uses the authored shared objective when resolving authoritative planning evidence", async () => {
		const fx = fixture();
		const authority = fx.runtime.hostingBudgetAuthority;
		if (!authority?.resolve) throw new Error("missing hosting authority");
		const resolve = authority.resolve;
		const objectives: string[] = [];
		const budgetPolicy = {
			schemaVersion: "hobo.budget-policy/v1",
			tenantId: "tenant",
			budgetId: "hosting",
			periodId: "period",
			revision: "r1",
			workloads: ["hosting"],
			currency: "USD",
			limitMicros: 100,
			objective: "maximize-credits",
			enforcement: "conservative",
			periodKind: "manual",
			constraints: [],
		};
		const authored = parseManifest({
			...manifest.value,
			policy: { budgetPolicy },
		});
		const client = createYardClient({
			...fx.runtime,
			hostingBudgetAuthority: {
				...authority,
				resolve: async (request) => {
					objectives.push(request.objective);
					return { ...(await resolve(request)), budgetPolicy };
				},
			},
		});
		const result = await client.planAuthoritatively(authored, {
			deploymentId: "one",
			session,
		});
		expect(result.ok).toBe(true);
		expect(objectives).toEqual(["maximize-credits"]);
		expect(fx.counts().reservations).toBe(0);
	});
	it("uses durable admission history for teardown after the manifest financial policy is removed", async () => {
		const fx = fixture(),
			client = createYardClient(fx.runtime);
		await client.up(manifest, { deploymentId: "one", session });
		const {
			hostingBudgetRequired: _required,
			defaultHostingBudgetId: _default,
			...runtime
		} = fx.runtime;
		await createYardClient(runtime).down(manifest, {
			deploymentId: "one",
			session,
		});
		expect(fx.counts().teardowns).toBe(1);
		expect(fx.counts().legacyWrites).toBe(0);
	});
	it("parses budget identity only on hosting verbs and rejects a missing value", () => {
		expect(parseArgv(["up", "--budget", "hosting"]).flags.budgetId).toBe(
			"hosting",
		);
		expect(parseArgv(["plan", "--budget-id", "hosting"]).flags.budgetId).toBe(
			"hosting",
		);
		expect(() => parseArgv(["up", "--budget"])).toThrow();
		expect(() => parseArgv(["doctor", "--budget", "hosting"])).toThrow();
	});
});
