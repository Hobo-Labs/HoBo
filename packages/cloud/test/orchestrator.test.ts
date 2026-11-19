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
	type Executor,
	foldResourceActor,
	type IacProgram,
	type IacProvider,
	type OrchestratorDeps,
	type ResourcePlan,
	reconcileResource,
	resourceActorKey,
	runOrchestrator,
} from "../src/index.js";
import { isJsonObject, isJsonString } from "../src/json.js";


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
				throw new Error(`apply failed for ${program.resourceId}`);
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy() {
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
			"token.Granted",
			"exec.Diff",
			"exec.Succeeded",
			"resource.Provisioned",
			"token.Used",
			"token.Revoked",
		]);
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

		const snapshot = await credentialAuditProjection.rebuildFromZero(
			deps.store,
			"deployment:audit-1",
		);
		const row = credentialAuditProjection.get(snapshot, "deploy:audit-1");
		expect(row).toBeDefined();
		if (!row) return;

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
			.map((e) =>
				isJsonObject(e.data) && isJsonString(e.data.resourceId)
					? e.data.resourceId
					: "",
			);
		expect(provisioned.indexOf("network")).toBeLessThan(
			provisioned.indexOf("database"),
		);
		expect(provisioned.indexOf("database")).toBeLessThan(
			provisioned.indexOf("api"),
		);
		expect(provisioned.indexOf("api")).toBeLessThan(provisioned.indexOf("web"));
		expect(events.at(-1)?.type).toBe("deployment.Deployed");

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

		const midEvents = await drain(store, "deployment:shop-crash");
		const midStates = midEvents
			.filter(
				(e) =>
					e.type === "resource.Provisioning" ||
					e.type === "resource.Provisioned",
			)
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
		const dbSnapshot = foldResourceActor(midEvents, {
			name: "database",
			port: "database",
			provider: "@hobo/provider-local",
			deps: ["network"],
			deploymentId: "shop-crash",
		});
		expect(dbSnapshot.state).toBe("Provisioning");

		const deps2: OrchestratorDeps = {
			store,
			actorHost: createInMemoryActorHost(),
			executor: createInProcessExecutor({ iac: mockIac() }),
			broker: createInProcessCredentialBroker(),
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

		const finalEvents = await drain(store, "deployment:shop-crash");
		const dbProvisioning = finalEvents.filter(
			(e) =>
				e.type === "resource.Provisioning" &&
				(e.data as { resourceId: string }).resourceId === "database",
		);
		expect(dbProvisioning.length).toBe(1);
		expect(finalEvents.at(-1)?.type).toBe("deployment.Deployed");
	});
});

describe("Orchestrator compensation: choreographed reverse-dependency rollback", () => {
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
		expect(result.compensation?.destroyedOrder).toEqual([
			"api",
			"cache",
			"database",
			"network",
		]);

		const events = await drain(deps.store, "deployment:shop-rollback");
		const types = events.map((e) => e.type);
		expect(types).toContain("deployment.RollbackStarted");
		expect(types).toContain("deployment.RolledBack");
		const rollbackStartedIdx = types.indexOf("deployment.RollbackStarted");
		const rolledBackIdx = types.indexOf("deployment.RolledBack");
		const firstDestroyIdx = types.indexOf("resource.Destroying");
		expect(rollbackStartedIdx).toBeLessThan(firstDestroyIdx);
		expect(rolledBackIdx).toBeGreaterThan(
			types.lastIndexOf("resource.Destroyed"),
		);

		const destroyed = events
			.filter((e) => e.type === "resource.Destroyed")
			.map((e) =>
				isJsonObject(e.data) && isJsonString(e.data.resourceId)
					? e.data.resourceId
					: "",
			);
		expect(destroyed).toEqual(["api", "cache", "database", "network"]);

		const view = await deploymentViewProjection.rebuildFromZero(
			deps.store,
			"deployment:shop-rollback",
		);
		const row = deploymentViewProjection.get(view, "shop-rollback");
		expect(row?.status).toBe("rolled-back");
		expect(row?.resources.web).toBe("failed");
		expect(row?.resources.network).toBe("destroyed");
	});
});
