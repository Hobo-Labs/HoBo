import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	credentialAuditProjection,
	type DeploymentPlan,
	deploymentViewProjection,
	destroyResource,
	type Executor,
	foldResourceActor,
	type IacProgram,
	type IacProvider,
	type OrchestratorDeps,
	type ResourcePlan,
	reconcileResource,
	resourceActorKey,
	runCompensation,
	runOrchestrator,
	topologyViewProjection,
} from "../src/index.js";
import { isJsonObject, isJsonString } from "../src/json.js";

// S2-03a/b: the provisioning path end to end. A DeploymentPlan DAG is choreographed
// by ResourceActors reconciling desired→observed through a sandboxed Executor;
// crash-resume replays the durable log; a no-go failure choreographs compensation
// in reverse-dependency order.

let stores: RuntimeLocalEventStore[] = [];
function freshStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(join(tmpdir(), "hobo-cloud-orch-"));
	const s = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	stores.push(s);
	return s;
}
afterEach(() => {
	for (const s of stores) s.close();
	stores = [];
});

function loadPlan(): DeploymentPlan {
	// SAFETY: `return JSON.parse(` is required at this I/O or test boundary.
	return JSON.parse(
		readFileSync(
			fileURLToPath(
				new URL("./fixtures/multi-cloud-shop-plan.json", import.meta.url),
			),
			"utf8",
		),
	) as DeploymentPlan;
}

const actor = { kind: "service", id: "yard/orchestrator" } as const;
const tenant = "tenant-shop";

function mockIac(opts: { failApply?: string[] } = {}): IacProvider {
	const fail = new Set(opts.failApply ?? []);
	return {
		id: "mock-local-container",
		async preview(program) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program) {
			if (fail.has(program.resourceId))
				throw Object.assign(
					new Error(`apply failed for ${program.resourceId}`),
					{ requiresReconciliation: false, executionOutcome: "not-started" },
				);
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy() {
			/* local backend no-op */
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}

function makeDeps(executor: Executor): OrchestratorDeps {
	return {
		store: freshStore(),
		actorHost: createInMemoryActorHost(),
		executor,
		broker: createInProcessCredentialBroker(),
	};
}

// Wrap an executor so it throws (a process-crash surrogate) on the FIRST apply of
// a targeted resource, AFTER resource.Provisioning is already durable on the log.
function crashOn(inner: Executor, resourceId: string): Executor {
	return {
		async run(program: IacProgram, credential, options) {
			if (program.action === "apply" && program.resourceId === resourceId) {
				throw new Error(`simulated crash provisioning ${resourceId}`);
			}
			return inner.run(program, credential, options);
		},
	};
}

async function drain(
	store: RuntimeLocalEventStore,
	streamId: string,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const e of store.read(streamId)) events.push(e);
	return events;
}

describe("ResourceActor: a resource provisions via the Executor", () => {
	it("dispatches an IacProgram and emits resource.Provisioned with captured outputs", async () => {
		const deps = makeDeps(createInProcessExecutor({ iac: mockIac() }));
		const network: ResourcePlan = {
			name: "network",
			port: "network",
			provider: "@hobo/provider-local",
			deps: [],
		};

		const outcome = await reconcileResource(
			{
				store: deps.store,
				actorHost: deps.actorHost,
				executor: deps.executor,
				broker: deps.broker,
			},
			{ ...network, deploymentId: "prov-1" },
			{ deploymentId: "prov-1", tenant, actor },
		);

		expect(outcome.kind).toBe("provisioned");
		if (outcome.kind !== "provisioned") return;
		expect(outcome.snapshot.state).toBe("Provisioned");
		expect(outcome.snapshot.outputs.endpoint).toBe("network.local");

		const events = await drain(deps.store, "deployment:prov-1");
		expect(events.map((e) => e.type)).toEqual([
			"resource.Provisioning",
			// Credential-audit trail (NFR-018): the scoped credential is granted,
			// used for the apply, then revoked — folded by credentialAuditProjection.
			"token.Granted",
			"exec.Diff",
			"exec.Succeeded",
			"resource.Provisioned",
			"token.Used",
			"token.Revoked",
		]);
		// The actor lease key is per-resource (control-plane.md single-writer lease).
		expect(resourceActorKey("prov-1", "network")).toBe(
			"resource:prov-1:network",
		);
	});

	it("emits a replayable credential-audit trail folded to grant -> use -> revoke (NFR-018)", async () => {
		const deps = makeDeps(createInProcessExecutor({ iac: mockIac() }));
		const network: ResourcePlan = {
			name: "network",
			port: "network",
			provider: "@hobo/provider-local",
			deps: [],
		};

		await reconcileResource(
			{
				store: deps.store,
				actorHost: deps.actorHost,
				executor: deps.executor,
				broker: deps.broker,
			},
			{ ...network, deploymentId: "audit-1" },
			{
				deploymentId: "audit-1",
				tenant,
				actor,
				correlationId: "deploy:audit-1",
			},
		);

		// The CredentialAudit read-model, rebuilt from zero over the durable log.
		const snapshot = await credentialAuditProjection.rebuildFromZero(
			deps.store,
			"deployment:audit-1",
		);
		const row = credentialAuditProjection.get(snapshot, "deploy:audit-1");
		expect(row).toBeDefined();
		if (!row) return;

		// One grant, used once, revoked — a complete lifecycle.
		expect(row.grantCount).toBe(1);
		expect(row.useCount).toBe(1);
		expect(row.revokeCount).toBe(1);
		const grants = Object.values(row.grants);
		expect(grants).toHaveLength(1);
		const g = grants[0];
		if (g === undefined) throw new Error("expected a grant");
		expect(g.status).toBe("revoked");
		expect(g.grantedAt).toBeDefined();
		expect(g.usedAt).toBeDefined();
		expect(g.revokedAt).toBeDefined();
		expect(g.scope).toEqual({
			port: "network",
			resource: "network",
			action: "apply",
		});
		// The timeline preserves grant -> use -> revoke ordering for the reviewer.
		expect(row.timeline.map((t) => t.type)).toEqual([
			"token.Granted",
			"token.Used",
			"token.Revoked",
		]);
	});
});

describe("Orchestrator: choreographs a DeploymentPlan DAG to deployment.Deployed", () => {
	it("provisions in dependency order and drives deployment.Deployed", async () => {
		const deps = makeDeps(createInProcessExecutor({ iac: mockIac() }));
		const plan = loadPlan();

		const result = await runOrchestrator(deps, plan, "shop-1", {
			tenant,
			actor,
			correlationId: "deploy:shop-1",
		});

		expect(result.status).toBe("deployed");
		expect(result.provisioned).toEqual([
			"api",
			"cache",
			"database",
			"network",
			"web",
		]);

		const events = await drain(deps.store, "deployment:shop-1");
		const provisioned = events
			.filter((e) => e.type === "resource.Provisioned")
			// SAFETY: `.map((e) => (e.data as { resourceId: string }).resourceId);` is required at this I/O or test boundary.
			.map((e) =>
				isJsonObject(e.data) && isJsonString(e.data.resourceId)
					? e.data.resourceId
					: "",
			);
		// Dependency order: network before database/cache before api before web.
		expect(provisioned.indexOf("network")).toBeLessThan(
			provisioned.indexOf("database"),
		);
		expect(provisioned.indexOf("database")).toBeLessThan(
			provisioned.indexOf("api"),
		);
		expect(provisioned.indexOf("api")).toBeLessThan(provisioned.indexOf("web"));
		expect(events.at(-1)?.type).toBe("deployment.Deployed");

		// The DeploymentView projection reconstructs the saga graph from the log.
		const view = await deploymentViewProjection.rebuildFromZero(
			deps.store,
			"deployment:shop-1",
		);
		const row = deploymentViewProjection.get(view, "shop-1");
		expect(row?.status).toBe("deployed");
		expect(row?.resources).toEqual({
			network: "provisioned",
			database: "provisioned",
			cache: "provisioned",
			api: "provisioned",
			web: "provisioned",
		});
	});
});

describe("Orchestrator crash-resume: replay the durable log to Deployed", () => {
	it("resumes a deploy killed mid-Provisioning by folding the event stream", async () => {
		const plan = loadPlan();
		const store = freshStore();

		// Run 1: crash while provisioning `database` (after network is Provisioned).
		const deps1: OrchestratorDeps = {
			store,
			actorHost: createInMemoryActorHost(),
			executor: crashOn(
				createInProcessExecutor({ iac: mockIac() }),
				"database",
			),
			broker: createInProcessCredentialBroker(),
		};
		await expect(
			runOrchestrator(deps1, plan, "shop-crash", { tenant, actor }),
		).rejects.toThrow(/simulated crash provisioning database/);

		// The log holds database at Provisioning with no terminal fact.
		const midEvents = await drain(store, "deployment:shop-crash");
		const midStates = midEvents
			.filter(
				(e) =>
					e.type === "resource.Provisioning" ||
					e.type === "resource.Provisioned",
			)
			// SAFETY: `.map((e) => `${e.type}:${(e.data as { resourceId: string }).resourceId}`);` is required at this I/O or test boundary.
			.map((e) => {
				const resourceId =
					isJsonObject(e.data) && isJsonString(e.data.resourceId)
						? e.data.resourceId
						: "";
				return `${e.type}:${resourceId}`;
			});
		expect(midStates).toContain("resource.Provisioned:network");
		expect(midStates).toContain("resource.Provisioning:database");
		expect(midStates).not.toContain("resource.Provisioned:database");
		// Folding the actor from the log alone shows the in-flight FSM state.
		const dbSnapshot = foldResourceActor(midEvents, {
			name: "database",
			port: "database",
			provider: "@hobo/provider-local",
			deps: ["network"],
			deploymentId: "shop-crash",
		});
		expect(dbSnapshot.state).toBe("Provisioning");

		// Run 2: drop ALL in-memory state (fresh actorHost/broker/executor), same
		// store — the orchestrator replays the log and converges to Deployed.
		const deps2: OrchestratorDeps = {
			store,
			actorHost: createInMemoryActorHost(),
			executor: createInProcessExecutor({ iac: mockIac() }),
			broker: createInProcessCredentialBroker(),
			verifyResume: async () => true,
		};
		const resumed = await runOrchestrator(deps2, plan, "shop-crash", {
			tenant,
			actor,
		});
		expect(resumed.status).toBe("deployed");
		expect(resumed.provisioned).toEqual([
			"api",
			"cache",
			"database",
			"network",
			"web",
		]);

		// database resumed with exactly one Provisioning fact — no duplicate restart.
		const finalEvents = await drain(store, "deployment:shop-crash");
		const dbProvisioning = finalEvents.filter(
			(e) =>
				e.type === "resource.Provisioning" &&
				// SAFETY: `(e.data as { resourceId: string }).resourceId === "database",` is required at this I/O or test boundary.
				(e.data as { resourceId: string }).resourceId === "database",
		);
		expect(dbProvisioning.length).toBe(1);
		expect(finalEvents.at(-1)?.type).toBe("deployment.Deployed");
	});
});

describe("Orchestrator compensation: choreographed reverse-dependency rollback", () => {
	it("durably pauses an uncertain apply without retry or compensation", async () => {
		const iac = mockIac();
		const apply = iac.apply.bind(iac);
		let uncertainCalls = 0;
		let destroys = 0;
		iac.apply = async (program) => {
			if (program.resourceId === "web") {
				uncertainCalls++;
				throw Object.assign(new Error("reconciliation required"), {
					requiresReconciliation: true,
					reservationId: "iac:reservation-1",
				});
			}
			return apply(program);
		};
		iac.destroy = async () => {
			destroys++;
		};
		const deps = makeDeps(createInProcessExecutor({ iac }));
		const plan = loadPlan();
		const context = { tenant, actor, noGoThresholdResources: new Set(["web"]) };
		const first = await runOrchestrator(deps, plan, "shop-uncertain", context);
		expect(first.status).toBe("needs-human");
		expect(
			first.events.find((event) => event.type === "resource.Failed")?.data,
		).toMatchObject({
			resourceId: "web",
			requiresReconciliation: true,
			reservationId: "iac:reservation-1",
			reconciliationOperation: "apply",
			crossedNoGoThreshold: false,
		});
		expect(first.events.map((event) => event.type)).not.toContain(
			"deployment.RolledBack",
		);
		const projection = await deploymentViewProjection.rebuildFromZero(
			deps.store,
			"deployment:shop-uncertain",
		);
		expect(
			deploymentViewProjection.get(projection, "shop-uncertain"),
		).toMatchObject({
			status: "needs-human",
			resources: { web: "reconciliation-required" },
			reconciliations: {
				web: {
					reason: expect.stringContaining("reconciliation required"),
					reservationId: "iac:reservation-1",
					operation: "apply",
				},
			},
		});
		const topology = await topologyViewProjection.rebuildFromZero(
			deps.store,
			"deployment:shop-uncertain",
		);
		expect(
			topologyViewProjection.get(topology, "shop-uncertain")?.nodes,
		).toContainEqual(
			expect.objectContaining({
				id: "resource:web",
				lifecycle: "reconciliation-required",
			}),
		);
		expect(destroys).toBe(0);
		const repeated = await runOrchestrator(
			deps,
			plan,
			"shop-uncertain",
			context,
		);
		expect(repeated.status).toBe("needs-human");
		expect(repeated.events).toHaveLength(first.events.length);
		expect(uncertainCalls).toBe(1);
		expect(destroys).toBe(0);
		const web = plan.resources.find((resource) => resource.name === "web");
		if (web === undefined) throw new Error("web resource missing");
		const lastEvent = first.events.at(-1);
		if (lastEvent === undefined) throw new Error("events missing");
		for (const type of [
			"resource.Provisioning",
			"resource.Destroying",
			"resource.Failed",
		]) {
			const later = {
				...lastEvent,
				seq: lastEvent.seq + 1,
				type,
				data: { deploymentId: "shop-uncertain", resourceId: "web" },
			};
			const history = [...first.events, later];
			expect(
				foldResourceActor(history, {
					...web,
					deploymentId: "shop-uncertain",
				}).state,
			).toBe("ReconciliationRequired");
			expect(
				deploymentViewProjection.get(
					deploymentViewProjection.fold(history),
					"shop-uncertain",
				),
			).toMatchObject({
				status: "needs-human",
				resources: { web: "reconciliation-required" },
			});
			expect(
				topologyViewProjection.get(
					topologyViewProjection.fold(history),
					"shop-uncertain",
				)?.nodes,
			).toContainEqual(
				expect.objectContaining({
					id: "resource:web",
					lifecycle: "reconciliation-required",
				}),
			);
		}
		const deploymentFacts = [
			{
				type: "deployment.Requested",
				data: { deploymentId: "shop-uncertain", bindleHash: "new" },
			},
			{
				type: "deployment.Imported",
				data: {
					deploymentId: "shop-uncertain",
					bindleHash: "new",
					resources: ["web"],
				},
			},
			{
				type: "deployment.Planned",
				data: { deploymentId: "shop-uncertain", planHash: "new", plan },
			},
			{
				type: "deployment.PlanRejected",
				data: {
					deploymentId: "shop-uncertain",
					reason: "rejected",
					remediations: [],
				},
			},
		];
		for (const fact of deploymentFacts) {
			const history = [
				...first.events,
				{ ...lastEvent, ...fact, seq: lastEvent.seq + 1 },
			];
			expect(
				deploymentViewProjection.get(
					deploymentViewProjection.fold(history),
					"shop-uncertain",
				),
			).toMatchObject({
				status: "needs-human",
				resources: { web: "reconciliation-required" },
			});
			expect(
				topologyViewProjection.get(
					topologyViewProjection.fold(history),
					"shop-uncertain",
				)?.nodes,
			).toContainEqual(
				expect.objectContaining({
					id: "resource:web",
					lifecycle: "reconciliation-required",
				}),
			);
		}
		const direct = await reconcileResource(deps, web, {
			deploymentId: "shop-uncertain",
			tenant,
			actor,
		});
		expect(direct).toMatchObject({
			kind: "reconciliation-required",
			snapshot: { state: "ReconciliationRequired" },
		});
		expect(uncertainCalls).toBe(1);
		const destroy = await destroyResource(deps, web, {
			deploymentId: "shop-uncertain",
			tenant,
			actor,
		});
		expect(destroy).toMatchObject({
			kind: "failed",
			snapshot: { state: "ReconciliationRequired" },
		});
		const compensation = await runCompensation(
			deps,
			plan,
			"shop-uncertain",
			{ resourceId: "web", reason: "manual" },
			{ tenant, actor },
		);
		expect(compensation.status).toBe("needs-human");
		expect(compensation.events.map((event) => event.type)).not.toContain(
			"deployment.RolledBack",
		);
		const revisedPlan = {
			...plan,
			resources: plan.resources.filter((resource) => resource.name !== "web"),
			dependencyOrder: plan.dependencyOrder.filter((name) => name !== "web"),
		};
		const revised = await runOrchestrator(
			deps,
			revisedPlan,
			"shop-uncertain",
			context,
		);
		expect(revised.status).toBe("needs-human");
		expect(revised.events).toHaveLength(first.events.length);
		const revisedCompensation = await runCompensation(
			deps,
			revisedPlan,
			"shop-uncertain",
			{ resourceId: "web", reason: "manual" },
			{ tenant, actor },
		);
		expect(revisedCompensation.status).toBe("needs-human");
		expect(revisedCompensation.events.map((event) => event.type)).not.toContain(
			"deployment.RolledBack",
		);
		expect(destroys).toBe(0);
	});

	it("durably blocks another destroy after its outcome becomes unknown", async () => {
		const iac = mockIac();
		let destroys = 0;
		iac.destroy = async () => {
			destroys++;
			throw Object.assign(new Error("destroy outcome unknown"), {
				requiresReconciliation: true,
				reservationId: "iac:destroy-1",
			});
		};
		const deps = makeDeps(createInProcessExecutor({ iac }));
		const resource: ResourcePlan = {
			name: "network",
			port: "network",
			provider: "local",
			deps: [],
		};
		const context = { deploymentId: "unknown-destroy", tenant, actor };
		expect((await reconcileResource(deps, resource, context)).kind).toBe(
			"provisioned",
		);
		const first = await destroyResource(deps, resource, context);
		expect(first).toMatchObject({
			kind: "failed",
			snapshot: { state: "ReconciliationRequired" },
		});
		const events = await drain(deps.store, "deployment:unknown-destroy");
		expect(
			events.find((event) => event.type === "resource.Failed")?.data,
		).toMatchObject({
			requiresReconciliation: true,
			reservationId: "iac:destroy-1",
			crossedNoGoThreshold: false,
			reconciliationOperation: "destroy",
		});
		expect((await destroyResource(deps, resource, context)).kind).toBe(
			"failed",
		);
		expect(destroys).toBe(1);
	});

	it("rolls back and destroys provisioned actors in reverse-dependency order", async () => {
		const deps = makeDeps(
			createInProcessExecutor({ iac: mockIac({ failApply: ["web"] }) }),
		);
		const plan = loadPlan();

		const result = await runOrchestrator(deps, plan, "shop-rollback", {
			tenant,
			actor,
			noGoThresholdResources: new Set(["web"]),
		});

		expect(result.status).toBe("rolled-back");
		// web failed (never provisioned); the four provisioned actors tear down
		// dependents-first: api, then cache/database, then network.
		expect(result.compensation?.destroyedOrder).toEqual([
			"api",
			"cache",
			"database",
			"network",
		]);

		const events = await drain(deps.store, "deployment:shop-rollback");
		const types = events.map((e) => e.type);
		expect(types).toContain("deployment.RolledBack");
		const rolledBackIdx = types.indexOf("deployment.RolledBack");
		const firstDestroyIdx = types.indexOf("resource.Destroying");
		expect(rolledBackIdx).toBeLessThan(firstDestroyIdx);

		const destroyed = events
			.filter((e) => e.type === "resource.Destroyed")
			// SAFETY: `.map((e) => (e.data as { resourceId: string }).resourceId);` is required at this I/O or test boundary.
			.map((e) =>
				isJsonObject(e.data) && isJsonString(e.data.resourceId)
					? e.data.resourceId
					: "",
			);
		expect(destroyed).toEqual(["api", "cache", "database", "network"]);

		// A destroyed resource is only torn down after its dependents are gone.
		const view = await deploymentViewProjection.rebuildFromZero(
			deps.store,
			"deployment:shop-rollback",
		);
		const row = deploymentViewProjection.get(view, "shop-rollback");
		expect(row?.status).toBe("rolled-back");
		expect(row?.resources.web).toBe("failed");
		expect(row?.resources.network).toBe("destroyed");
	});

	it("resumes a destroy interrupted during compensation with the same generation", async () => {
		const plan = loadPlan();
		const resource = plan.resources.find((item) => item.name === "network");
		if (!resource) throw new Error("network resource missing");
		const inner = createInProcessExecutor({ iac: mockIac() });
		const observed: (string | undefined)[] = [];
		let crash = true;
		const executor: Executor = {
			async run(program, credential, options) {
				if (program.action === "destroy") {
					observed.push(program.operationGeneration);
					if (crash) {
						crash = false;
						throw new Error("destroy interrupted");
					}
				}
				return inner.run(program, credential, options);
			},
		};
		const deps = { ...makeDeps(executor), verifyResume: async () => true };
		const context = { deploymentId: "compensation-resume", tenant, actor };
		await reconcileResource(deps, resource, context);
		const compensate = () =>
			runCompensation(
				deps,
				plan,
				context.deploymentId,
				{ resourceId: "web", reason: "failure" },
				{ tenant, actor },
			);
		await expect(compensate()).rejects.toThrow("destroy interrupted");
		expect((await compensate()).destroyedOrder).toContain("network");
		expect(observed).toHaveLength(2);
		expect(observed[0]).toEqual(expect.any(String));
		expect(observed[1]).toBe(observed[0]);
	});
});
