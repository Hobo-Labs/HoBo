import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseManifest } from "@hobo/bindles";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	type PlanBindingAuthority,
	type SharedHostingBudgetAuthority,
} from "@hobo/cloud";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { persistSession } from "../src/cloud/session.js";
import {
	createYardClient,
	planHostingAuthoritatively,
	type YardRuntime,
	type YardSession,
} from "../src/cloud/yard-client.js";
import { createPlanCommand } from "../src/commands/plan.js";
import { createUpCommand } from "../src/commands/up.js";
import { createHoboCli } from "../src/index.js";
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
const unreachedAuthorityFields: Pick<
	PlanBindingAuthority,
	"profiles" | "policy"
> = {
	profiles: {
		digest: "sha256:no-capability-profiles",
		get: () => undefined,
		require: () => {
			throw new Error("no fixture path registers capability profiles");
		},
		has: () => false,
		list: () => [],
		closureOf: () => [],
		satisfies: () => false,
		guaranteeKeys: () => [],
	},
	policy: {
		minimumProviderClass: "verified-emerging",
		creatorAuthorityAfterClaim: "must-be-rotatable",
		maximumClaimActions: 2,
		maximumEvidenceAgeMs: 30 * 24 * 60 * 60 * 1000,
		requireExportProfile: false,
		allowSponsor: true,
		allowPack: true,
		allowBridge: true,
		sponsorBudgetMinorUnits: 0,
	},
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
		hostingPlanBinding: async () => ({
			yard: { yardId: "yard", providerId: "host", bindings: [] },
			definitions: [],
			...unreachedAuthorityFields,
			nowMs: 1000,
			requirements: {},
		}),
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
	it("rejects unverified target selectors for a budgeted runtime before consulting the registry or authority", async () => {
		const fx = fixture();
		const cwd = mkdtempSync(join(tmpdir(), "cli-hosting-target-"));
		dispose.push(() => rmSync(cwd, { recursive: true, force: true }));
		writeFileSync(
			join(cwd, "hobo.bindle.json"),
			JSON.stringify(manifest.value),
		);
		let refreshes = 0;
		let bindings = 0;
		const runtime: YardRuntime = {
			...fx.runtime,
			registry: {
				...fx.runtime.registry,
				refresh: async () => {
					refreshes++;
				},
			},
			hostingPlanBinding: async (request) => {
				bindings++;
				if (!fx.runtime.hostingPlanBinding) throw new Error("missing binding");
				return fx.runtime.hostingPlanBinding(request);
			},
		};
		const cli = createHoboCli({
			commands: {
				plan: createPlanCommand({ runtime, session }),
				up: createUpCommand({ runtime, session }),
			},
		});
		for (const args of [
			["--camp", "foreign", "plan", "--json"],
			["plan", "--target", "foreign", "--json"],
			["plan", "foreign", "--json"],
			["--camp", "foreign", "up", "--what-if", "--json"],
			["up", "--what-if", "--broker", "https://foreign.test", "--json"],
			["up", "--what-if", "--broker-uri", "https://foreign.test", "--json"],
		]) {
			const result = await cli.run(args, { cwd });
			expect(JSON.parse(result.stdout)).toMatchObject({
				ok: false,
				code: "HOBO_PLAN_TARGET_UNAVAILABLE",
			});
		}
		const { defaultHostingBudgetId: _defaultBudgetId, ...budgetOnlyRuntime } =
			runtime;
		const budgetOnly = createHoboCli({
			commands: {
				plan: createPlanCommand({
					runtime: { ...budgetOnlyRuntime, hostingBudgetRequired: false },
					session,
				}),
			},
		});
		const explicitBudget = await budgetOnly.run(
			["plan", "--budget", "hosting", "--target", "foreign", "--json"],
			{ cwd },
		);
		expect(JSON.parse(explicitBudget.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_PLAN_TARGET_UNAVAILABLE",
		});
		expect({ refreshes, bindings }).toEqual({ refreshes: 0, bindings: 0 });
		expect(fx.counts()).toEqual({
			legacyWrites: 0,
			reservations: 0,
			supervised: 0,
			teardowns: 0,
		});
	});
	it("uses the requested session for what-if and does not borrow it for anonymous previews", async () => {
		const fx = fixture();
		const cwd = mkdtempSync(join(tmpdir(), "cli-hosting-preview-session-"));
		dispose.push(() => rmSync(cwd, { recursive: true, force: true }));
		writeFileSync(
			join(cwd, "hobo.bindle.json"),
			JSON.stringify(manifest.value),
		);
		const seen: YardSession[] = [];
		const runtime: YardRuntime = {
			...fx.runtime,
			hostingPlanBinding: async (request) => {
				seen.push(request.session);
				if (!fx.runtime.hostingPlanBinding) throw new Error("missing binding");
				return fx.runtime.hostingPlanBinding(request);
			},
		};
		const cli = createHoboCli({
			commands: { up: createUpCommand({ runtime, session }) },
		});
		const preview = await cli.run(["up", "--what-if", "--json"], { cwd });
		expect(JSON.parse(preview.stdout)).toMatchObject({ ok: true });
		expect(seen[0]).toEqual(session);
		await persistSession(cwd, session);
		await cli.run(["up", "--what-if", "--anonymous", "--json"], { cwd });
		expect(seen[1]).toMatchObject({
			tenant: "hobo-dev",
			principal: { id: "user:anonymous" },
		});
		await cli.run(["up", "--what-if", "--temporary", "--json"], { cwd });
		expect(seen[2]).toMatchObject({
			tenant: "hobo-dev",
			principal: { id: "user:anonymous" },
		});
		expect(fx.counts()).toEqual({
			legacyWrites: 0,
			reservations: 0,
			supervised: 0,
			teardowns: 0,
		});
	});
	it("never resolves budget evidence without a trusted binding even when hosting is optional", async () => {
		const fx = fixture();
		const { hostingPlanBinding: _binding, ...runtime } = fx.runtime;
		const authority = fx.runtime.hostingBudgetAuthority;
		if (!authority) throw new Error("missing hosting authority");
		let resolutions = 0;
		const result = await createYardClient({
			...runtime,
			hostingBudgetRequired: false,
			hostingBudgetAuthority: {
				...authority,
				resolve: async (request) => {
					resolutions++;
					return authority.resolve(request);
				},
			},
		}).planAuthoritatively(manifest, { deploymentId: "one", session });
		expect(result).toMatchObject({
			ok: false,
			reason: "trusted Yard binding is not configured",
		});
		expect(resolutions).toBe(0);
	});
	it("rejects a malformed hosting plan binding before invoking it", async () => {
		const fx = fixture();
		const authority = fx.runtime.hostingBudgetAuthority;
		if (!authority) throw new Error("missing hosting authority");
		let resolutions = 0;
		const runtime: YardRuntime = {
			...fx.runtime,
			hostingBudgetRequired: false,
			hostingBudgetAuthority: {
				...authority,
				resolve: async (request) => {
					resolutions++;
					return authority.resolve(request);
				},
			},
		};
		Object.assign(runtime, { hostingPlanBinding: true });
		const result = await createYardClient(runtime).planAuthoritatively(
			manifest,
			{ deploymentId: "one", session },
		);
		expect(result).toMatchObject({
			ok: false,
			reason: "trusted Yard binding is not configured",
		});
		expect(resolutions).toBe(0);
	});
	it("does not preview an unsupported hosting deployment mode as an executable change", async () => {
		const fx = fixture();
		const cwd = mkdtempSync(join(tmpdir(), "cli-hosting-mode-"));
		dispose.push(() => rmSync(cwd, { recursive: true, force: true }));
		writeFileSync(
			join(cwd, "hobo.bindle.json"),
			JSON.stringify(manifest.value),
		);
		const cli = createHoboCli({
			commands: { plan: createPlanCommand({ runtime: fx.runtime }) },
		});
		const result = await cli.run(["plan", "--mode", "complete", "--json"], {
			cwd,
		});
		expect(JSON.parse(result.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_DEPLOYMENT_MODE_UNSUPPORTED",
		});
		expect(fx.counts()).toEqual({
			legacyWrites: 0,
			reservations: 0,
			supervised: 0,
			teardowns: 0,
		});
	});
	it("refuses an explicit deployment mode before reserving or invoking a hosting supervisor that cannot honor it", async () => {
		const fx = fixture();
		const result = await createYardClient(fx.runtime).up(manifest, {
			deploymentId: "one",
			session,
			config: { mode: "complete" },
		});
		expect(result.status).toBe("rejected");
		expect(fx.counts()).toEqual({
			legacyWrites: 0,
			reservations: 0,
			supervised: 0,
			teardowns: 0,
		});
	});
	it("plans through read-only hosting authority using the authenticated session", async () => {
		const fx = fixture();
		const authority = fx.runtime.hostingBudgetAuthority;
		if (!authority) throw new Error("missing hosting authority");
		const cwd = mkdtempSync(join(tmpdir(), "cli-hosting-plan-"));
		dispose.push(() => rmSync(cwd, { recursive: true, force: true }));
		writeFileSync(
			join(cwd, "hobo.bindle.json"),
			JSON.stringify(manifest.value),
		);
		const subjects: string[] = [];
		const preflightRuntime = {
			registry: {
				...fx.runtime.registry,
				refresh: async () => {
					throw new Error("read-only planning must not refresh mutable state");
				},
			},
			hostingBudgetAuthority: {
				persistence: authority.persistence,
				resolve: async (request: Parameters<typeof authority.resolve>[0]) => {
					subjects.push(`${request.tenantId}:${request.budgetId}`);
					return authority.resolve(request);
				},
			},
			defaultHostingBudgetId: "hosting",
			hostingBudgetRequired: true,
		};
		const missingSession = createHoboCli({
			commands: { plan: createPlanCommand({ preflightRuntime }) },
		});
		const rejected = await missingSession.run(["plan", "--json"], { cwd });
		expect(JSON.parse(rejected.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_HOSTING_SESSION_REQUIRED",
		});
		expect(subjects).toEqual([]);
		const foreignTarget = await missingSession.run(
			["--camp", "another-camp", "plan", "--json"],
			{ cwd },
		);
		expect(JSON.parse(foreignTarget.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_PLAN_TARGET_UNAVAILABLE",
		});
		expect(subjects).toEqual([]);
		const unbound = createHoboCli({
			commands: { plan: createPlanCommand({ preflightRuntime, session }) },
		});
		const missingBinding = await unbound.run(["plan", "--json"], { cwd });
		expect(JSON.parse(missingBinding.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_PLAN_REJECTED",
		});
		expect(subjects).toEqual([]);
		const binding: PlanBindingAuthority = {
			yard: { yardId: "yard", providerId: "host", bindings: [] },
			definitions: [],
			...unreachedAuthorityFields,
			nowMs: 1000,
			requirements: {},
		};
		const boundRuntime = {
			...preflightRuntime,
			hostingPlanBinding: async () => {
				expect(subjects).toEqual([]);
				return binding;
			},
		};
		await expect(
			planHostingAuthoritatively(
				{
					...boundRuntime,
					hostingPlanBinding: async () => {
						throw new Error("untrusted session");
					},
				},
				manifest,
				{ deploymentId: "one", session },
			),
		).rejects.toThrow("untrusted session");
		expect(subjects).toEqual([]);
		const cli = createHoboCli({
			commands: {
				plan: createPlanCommand({ preflightRuntime: boundRuntime, session }),
			},
		});
		const planned = await cli.run(["plan", "--region", "us", "--json"], {
			cwd,
		});
		expect(JSON.parse(planned.stdout)).toMatchObject({
			ok: true,
			data: { command: "plan", resources: [{ name: "app" }] },
		});
		expect(subjects).toEqual(["tenant:hosting"]);
		expect(JSON.parse(planned.stdout).data.changes).toBeUndefined();
		const unsupported = await cli.run(
			["plan", "--mode", "complete", "--json"],
			{ cwd },
		);
		expect(JSON.parse(unsupported.stdout)).toMatchObject({
			ok: false,
			code: "HOBO_DEPLOYMENT_MODE_UNSUPPORTED",
		});
		expect(subjects).toEqual(["tenant:hosting"]);
		expect(fx.counts()).toEqual({
			legacyWrites: 0,
			reservations: 0,
			supervised: 0,
			teardowns: 0,
		});
	});
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
	it("refuses budget-required planning without a host Yard binding", async () => {
		const fx = fixture();
		const { hostingPlanBinding: _removed, ...runtime } = fx.runtime;
		const result = await createYardClient(runtime).planAuthoritatively(
			manifest,
			{ deploymentId: "one", session },
		);
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.reason).toContain("trusted Yard binding");
		expect(fx.counts()).toEqual({
			legacyWrites: 0,
			reservations: 0,
			supervised: 0,
			teardowns: 0,
		});
	});
	it("checks trusted Yard product ownership during authoritative planning", async () => {
		const fx = fixture();
		let checked = 0;
		const binding: PlanBindingAuthority = {
			yard: {
				yardId: "yard",
				providerId: "host",
				bindings: [{ profile: "api.http/v1", productId: "foreign.product/v1" }],
			},
			definitions: [],
			...unreachedAuthorityFields,
			nowMs: 1000,
			requirements: {},
		};
		const client = createYardClient({
			...fx.runtime,
			hostingPlanBinding: async ({ deploymentId, session: subject }) => {
				checked++;
				expect(deploymentId).toBe("one");
				expect(subject).toEqual(session);
				return binding;
			},
		});
		const result = await client.planAuthoritatively(manifest, {
			deploymentId: "one",
			session,
		});
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.reason).toContain("Yard products must belong");
		expect(checked).toBe(1);
		expect(fx.counts()).toEqual({
			legacyWrites: 0,
			reservations: 0,
			supervised: 0,
			teardowns: 0,
		});
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
