import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { create } from "@bufbuild/protobuf";
import { parseManifest } from "@hobo/bindles";
import {
	BudgetLedgerSnapshotSchema,
	createSqliteBudgetAdmissionAuthority,
	HostingQuoteSchema,
} from "@hobo/broker";
import {
	collectStream,
	createInProcessCredentialBroker,
	createInProcessExecutor,
	type IacProgram,
	type IacProvider,
	type PlannerRegistry,
	type ResourceDefinition,
} from "@hobo/cloud";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";

import {
	createFixtureSession,
	createHoboCli,
	createUpCommand,
	createYardClient,
	type YardRuntime,
} from "../src/index.js";

// A failed provider call may have changed infrastructure before it timed out.

const DB_ONLY = {
	schema: "hobo.manifest/v1",
	componentHost: { kind: "wasmtime", version: "1.0.0" },
	resources: { db: { type: "data.v1", port: "sql" } },
};

function postgres(
	providerId: string,
	marginalPrice: string,
): ResourceDefinition {
	return {
		id: `${providerId}:sql`,
		providerId,
		port: "sql",
		features: [],
		regions: ["us-east-1"],
		specificity: 10,
		priority: 0,
		cost: { sku: "sql-standard", unit: "gb", marginalPrice },
		satisfies: (req) =>
			req.port === "sql" ? { kind: "full" } : { kind: "none" },
	};
}

const registry: PlannerRegistry = {
	catalogHash: "sha256:availability-routing",
	definitions: () => [postgres("neon", "0.001"), postgres("supabase", "0.002")],
	providers: () => ["neon", "supabase"],
};

let stores: RuntimeLocalEventStore[] = [];
let budgets: ReturnType<typeof createSqliteBudgetAdmissionAuthority>[] = [];
const dirs: string[] = [];
afterEach(async () => {
	for (const store of stores) store.close();
	stores = [];
	for (const budget of budgets) budget.close();
	budgets = [];
	for (const dir of dirs.splice(0))
		await rm(dir, { recursive: true, force: true });
});

function runtimeWith(
	down: ReadonlySet<string>,
	applied: string[],
	failAfterEffect = false,
	beforeFailedEffect?: (program: IacProgram) => void,
	attempts?: string[],
): YardRuntime {
	const iac: IacProvider = {
		id: "mock",
		async preview(program: IacProgram) {
			attempts?.push(`preview:${program.resourceId}@${program.provider}`);
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program: IacProgram) {
			attempts?.push(`apply:${program.resourceId}@${program.provider}`);
			if (down.has(program.provider)) {
				if (failAfterEffect) {
					beforeFailedEffect?.(program);
					applied.push(`${program.resourceId}@${program.provider}`);
				}
				throw new Error(`${program.provider} is not answering`);
			}
			applied.push(`${program.resourceId}@${program.provider}`);
			return { endpoint: `${program.resourceId}.${program.provider}` };
		},
		async destroy(program: IacProgram) {
			attempts?.push(`destroy:${program.resourceId}@${program.provider}`);
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
	const store = createRuntimeLocalEventStore({
		dataDir: path.join(
			tmpdir(),
			`hobo-availability-${Math.random().toString(36).slice(2)}`,
		),
		clock: createManualClock(),
	});
	stores.push(store);
	return {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac }),
		broker: createInProcessCredentialBroker(),
		registry,
	};
}

async function project(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "hobo-availability-project-"));
	dirs.push(dir);
	await writeFile(path.join(dir, "hobo.bindle.json"), JSON.stringify(DB_ONLY));
	return dir;
}

describe("availability-aware up", () => {
	it("deploys on the cheapest provider when it answers", async () => {
		const applied: string[] = [];
		const cli = createHoboCli({
			commands: {
				up: createUpCommand({ runtime: runtimeWith(new Set(), applied) }),
			},
		});
		const result = await cli.run(["up", "--json"], { cwd: await project() });
		expect(result.exitCode).toBe(0);
		expect(applied).toEqual(["db@neon"]);
	});

	it("does not route an uncertain apply to another provider", async () => {
		const applied: string[] = [];
		const attempts: string[] = [];
		const now = "2026-10-29T12:00:00Z";
		const directory = await mkdtemp(
			path.join(tmpdir(), "hobo-uncertain-budget-"),
		);
		dirs.push(directory);
		const budgetPath = path.join(directory, "budget.sqlite");
		const snapshot = create(BudgetLedgerSnapshotSchema, {
			identity: {
				tenantId: "tenant",
				budgetId: "hosting",
				periodId: "2026-10",
				policyRevision: "r1",
			},
			limitMicros: 100,
			observedAt: "2026-10-29T00:00:00Z",
			validUntil: "2026-11-01T00:00:00Z",
		});
		const authority = createSqliteBudgetAdmissionAuthority({
			path: budgetPath,
			snapshot,
			now: () => now,
		});
		budgets.push(authority);
		const runtime = runtimeWith(
			new Set(["neon"]),
			applied,
			true,
			(program) => {
				const current = authority.read(now);
				if (!current.identity) throw new Error("missing budget identity");
				const quote = create(HostingQuoteSchema, {
					quoteId: "quote-neon",
					yardId: "yard",
					providerId: program.provider,
					ownerTenantId: current.identity.tenantId,
					currency: "USD",
					totalMicros: 40,
					liabilityBoundMicros: 60,
					components: [{ name: "db", costMicros: 40 }],
					requestDigest: "request-neon",
					observedAt: "2026-10-29T00:00:00Z",
					validUntil: "2026-11-01T00:00:00Z",
				});
				authority.reserve({
					reservationId: "hold-neon",
					requestDigest: quote.requestDigest,
					quote,
					identity: current.identity,
					expectedSeq: current.seq,
					now,
				});
				authority.claimExecution({
					reservationId: "hold-neon",
					requestDigest: quote.requestDigest,
					executionDigest: "execute-neon",
				});
			},
			attempts,
		);
		const client = createYardClient(runtime);
		const bindle = parseManifest(DB_ONLY);
		const options = {
			deploymentId: "uncertain",
			session: createFixtureSession({ tenant: "tenant" }),
		};
		const initial = await client.up(bindle, options);
		expect(initial.status).toBe("needs-human");
		if (initial.status === "rejected") throw new Error(initial.reason);
		expect(initial.progress).toContainEqual(
			expect.objectContaining({
				type: "resource.Failed",
				resourceId: "db",
				reconciliation: { operation: "apply" },
				detail: expect.stringContaining(
					"Reconcile the provider before retrying",
				),
			}),
		);
		expect(applied).toEqual(["db@neon"]);
		expect(attempts).toEqual(["preview:db@neon", "apply:db@neon"]);
		const firstHistory = await collectStream(
			runtime.store,
			"deployment:uncertain",
		);
		const failures = firstHistory.filter(
			(event) => event.type === "resource.Failed",
		);
		expect(failures).toHaveLength(1);
		expect(failures[0]?.data).toMatchObject({
			resourceId: "db",
			classification: "fatal",
			requiresReconciliation: true,
			reconciliationOperation: "apply",
		});
		expect(authority.lookup("hold-neon")).toMatchObject({
			status: "held",
			executionDigest: "execute-neon",
		});
		expect(authority.read(now).reservedMicros).toBe(60);
		const reopened = createSqliteBudgetAdmissionAuthority({
			path: budgetPath,
			snapshot,
			now: () => now,
		});
		budgets.push(reopened);
		expect(reopened.lookup("hold-neon")).toMatchObject({
			status: "held",
			executionDigest: "execute-neon",
		});
		expect((await client.up(bindle, options)).status).toBe("needs-human");
		expect(attempts).toEqual(["preview:db@neon", "apply:db@neon"]);
		expect(reopened.read(now).reservedMicros).toBe(60);
		const rerun = await client.up(bindle, {
			...options,
			config: { unavailableProviders: ["neon"] },
		});
		expect(rerun.status).toBe("needs-human");
		expect(applied).toEqual(["db@neon"]);
		expect(attempts).toEqual(["preview:db@neon", "apply:db@neon"]);
		const history = await collectStream(runtime.store, "deployment:uncertain");
		expect(
			history
				.filter((event) => event.type === "resource.Failed")
				.map((event) => event.id),
		).toEqual(failures.map((event) => event.id));
		expect(
			history.some(
				(event) =>
					event.type === "resource.Reconciled" ||
					event.type === "resource.Provisioned",
			),
		).toBe(false);
		expect(reopened.lookup("hold-neon")).toMatchObject({
			status: "held",
			executionDigest: "execute-neon",
		});
		expect(reopened.read(now).reservedMicros).toBe(60);
	});

	it("uses an excluded provider set on a fresh deployment and replays it safely", async () => {
		const applied: string[] = [];
		const client = createYardClient(runtimeWith(new Set(), applied));
		const bindle = parseManifest(DB_ONLY);
		const options = {
			deploymentId: "fresh",
			session: createFixtureSession(),
			config: { unavailableProviders: ["neon"] },
		};
		expect((await client.up(bindle, options)).status).toBe("deployed");
		expect((await client.up(bindle, options)).status).toBe("deployed");
		expect(applied).toEqual(["db@supabase"]);
	});

	it("does not move a previously provisioned database when availability changes", async () => {
		const applied: string[] = [];
		const client = createYardClient(runtimeWith(new Set(), applied));
		const bindle = parseManifest(DB_ONLY);
		const options = {
			deploymentId: "existing",
			session: createFixtureSession(),
		};
		expect((await client.up(bindle, options)).status).toBe("deployed");
		expect(
			(
				await client.up(bindle, {
					...options,
					config: { unavailableProviders: ["neon"] },
				})
			).status,
		).toBe("needs-human");
		expect(applied).toEqual(["db@neon"]);
	});
});

describe("re-running up after editing the project", () => {
	it("converges the changed declaration instead of refusing a bound deployment id", async () => {
		const applied: string[] = [];
		const runtime = runtimeWith(new Set(), applied);
		const cli = createHoboCli({
			commands: { up: createUpCommand({ runtime }) },
		});
		const dir = await project();
		expect((await cli.run(["up", "--json"], { cwd: dir })).exitCode).toBe(0);
		await writeFile(
			path.join(dir, "hobo.bindle.json"),
			JSON.stringify({
				...DB_ONLY,
				resources: {
					...DB_ONLY.resources,
					replica: { type: "data.v1", port: "sql" },
				},
			}),
		);
		const again = await cli.run(["up", "--json"], { cwd: dir });
		expect(again.exitCode, again.stdout).toBe(0);
		// Only the new resource was applied: the unchanged one was a no-op.
		expect(applied).toEqual(["db@neon", "replica@neon"]);
		// And an unchanged re-run is idempotent: nothing applied.
		expect((await cli.run(["up", "--json"], { cwd: dir })).exitCode).toBe(0);
		expect(applied).toEqual(["db@neon", "replica@neon"]);
	});
});
