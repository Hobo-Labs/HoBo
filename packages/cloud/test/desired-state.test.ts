import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import { emit } from "@hobo/events";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	type DeploymentPlan,
	deploymentPlanned,
	desiredSpecHash,
	type IacProgram,
	type IacProvider,
	type OrchestratorDeps,
	orphansToPrune,
	parseDeploymentMode,
	planDeploymentChanges,
	runCompensation,
	runOrchestrator,
} from "../src/index.js";

// Desired State Reconciliation: `up` is an upsert over the durable log.
// Re-running an unchanged declaration is a no-op (idempotent deployment), a
// changed spec updates in place, `down` then `up` re-creates, and `complete`
// mode prunes what is no longer declared.

let stores: RuntimeLocalEventStore[] = [];
afterEach(() => {
	for (const s of stores) s.close();
	stores = [];
});

function freshStore(): RuntimeLocalEventStore {
	const s = createRuntimeLocalEventStore({
		dataDir: mkdtempSync(join(tmpdir(), "hobo-desired-state-")),
		clock: createManualClock(),
	});
	stores.push(s);
	return s;
}

function loadPlan(): DeploymentPlan {
	// SAFETY: fixture JSON is a DeploymentPlan by construction.
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

interface RecordingIac extends IacProvider {
	readonly calls: string[];
}

function recordingIac(): RecordingIac {
	const calls: string[] = [];
	return {
		id: "mock-local-container",
		calls,
		async preview(program: IacProgram) {
			return { summary: `preview ${program.resourceId}`, changes: 1 };
		},
		async apply(program: IacProgram) {
			calls.push(`apply:${program.resourceId}`);
			return { endpoint: `${program.resourceId}.local` };
		},
		async destroy(program: IacProgram) {
			calls.push(`destroy:${program.resourceId}`);
		},
		async refresh() {
			return { drift: false, observed: {} };
		},
	};
}

function deps(
	store: RuntimeLocalEventStore,
	iac: IacProvider,
): OrchestratorDeps {
	return {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac }),
		broker: createInProcessCredentialBroker(),
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

async function recordPlan(
	store: RuntimeLocalEventStore,
	deploymentId: string,
	plan: DeploymentPlan,
): Promise<void> {
	const stream = `deployment:${deploymentId}`;
	const events = await drain(store, stream);
	await emit(
		store,
		stream,
		[deploymentPlanned({ deploymentId, planHash: "sha256:test", plan })],
		{ expectedSeq: events.at(-1)?.seq ?? 0, actor, tenant },
	);
}

describe("desiredSpecHash", () => {
	it("is stable under dependency order and ignores the deployment id", () => {
		const a = {
			name: "api",
			port: "compute",
			provider: "p",
			deps: ["db", "cache"],
		};
		expect(desiredSpecHash(a)).toBe(
			desiredSpecHash({ ...a, deps: ["cache", "db"], deploymentId: "x" }),
		);
		expect(desiredSpecHash(a)).not.toBe(
			desiredSpecHash({ ...a, region: "eu-west-1" }),
		);
		expect(desiredSpecHash(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
	});
});

describe("parseDeploymentMode", () => {
	it("defaults to incremental and refuses anything else", () => {
		expect(parseDeploymentMode(undefined)).toBe("incremental");
		expect(parseDeploymentMode("complete")).toBe("complete");
		expect(() => parseDeploymentMode("replace")).toThrow(/incremental/);
	});
});

describe("idempotent deployment", () => {
	it("re-running an unchanged plan calls no provider and appends no fact", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		const first = await runOrchestrator(deps(store, iac), plan, "idem", {
			tenant,
			actor,
		});
		expect(first.status).toBe("deployed");
		expect(first.changes.summary.create).toBe(plan.resources.length);
		const applies = iac.calls.length;
		const before = await drain(store, "deployment:idem");

		const second = await runOrchestrator(deps(store, iac), plan, "idem", {
			tenant,
			actor,
		});
		expect(second.status).toBe("deployed");
		expect(second.changes.converged).toBe(true);
		expect(second.changes.summary["no-op"]).toBe(plan.resources.length);
		expect(iac.calls.length).toBe(applies);
		expect((await drain(store, "deployment:idem")).length).toBe(before.length);
	});
});

describe("upsert", () => {
	it("updates only the resource whose declared spec changed", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await runOrchestrator(deps(store, iac), plan, "upsert", { tenant, actor });
		iac.calls.length = 0;

		const changed: DeploymentPlan = {
			...plan,
			resources: plan.resources.map((r) =>
				r.name === "cache" ? { ...r, region: "eu-central-1" } : r,
			),
		};
		const whatIf = planDeploymentChanges(
			changed,
			await drain(store, "deployment:upsert"),
		);
		expect(
			whatIf.changes
				.filter((c) => c.action !== "no-op")
				.map((c) => c.resourceId),
		).toEqual(["cache"]);
		expect(whatIf.changes.find((c) => c.resourceId === "cache")?.action).toBe(
			"update",
		);

		const result = await runOrchestrator(deps(store, iac), changed, "upsert", {
			tenant,
			actor,
		});
		expect(result.status).toBe("deployed");
		expect(iac.calls).toEqual(["apply:cache"]);
		const events = await drain(store, "deployment:upsert");
		expect(events.filter((e) => e.type === "deployment.Deployed").length).toBe(
			2,
		);
		// The update converges: a third run is a no-op again.
		iac.calls.length = 0;
		await runOrchestrator(deps(store, iac), changed, "upsert", {
			tenant,
			actor,
		});
		expect(iac.calls).toEqual([]);
	});
});

describe("create/destroy cycle", () => {
	it("up after down re-creates every resource", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		const d = deps(store, iac);
		await runOrchestrator(d, plan, "cycle", { tenant, actor });
		const down = await runCompensation(
			d,
			plan,
			"cycle",
			{ resourceId: "*", reason: "operator-requested teardown" },
			{ tenant, actor },
		);
		expect(down.destroyedOrder.length).toBe(plan.resources.length);

		iac.calls.length = 0;
		const again = await runOrchestrator(deps(store, iac), plan, "cycle", {
			tenant,
			actor,
		});
		expect(again.status).toBe("deployed");
		expect(again.changes.summary.create).toBe(plan.resources.length);
		expect(iac.calls.filter((c) => c.startsWith("apply:")).length).toBe(
			plan.resources.length,
		);
	});

	it("a rolled-back failure does not block the next up", async () => {
		const store = freshStore();
		const plan = loadPlan();
		const failing: IacProvider = {
			...recordingIac(),
			async apply(program: IacProgram) {
				if (program.resourceId === "web") throw new Error("web down");
				return {};
			},
		};
		const first = await runOrchestrator(deps(store, failing), plan, "retry", {
			tenant,
			actor,
			noGoThresholdResources: new Set(["web"]),
		});
		expect(first.status).toBe("rolled-back");

		const second = await runOrchestrator(
			deps(store, recordingIac()),
			plan,
			"retry",
			{ tenant, actor },
		);
		expect(second.status).toBe("deployed");
	});
});

describe("deployment modes", () => {
	it("incremental retains undeclared resources; complete prunes them dependents-first", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await recordPlan(store, "modes", plan);
		await runOrchestrator(deps(store, iac), plan, "modes", { tenant, actor });

		// Drop `web` (a leaf) and `api` (web's dependency) from the declaration.
		const smaller: DeploymentPlan = {
			...plan,
			resources: plan.resources.filter(
				(r) => r.name !== "web" && r.name !== "api",
			),
			dependencyOrder: plan.dependencyOrder.filter(
				(n) => n !== "web" && n !== "api",
			),
		};
		const events = await drain(store, "deployment:modes");
		const incremental = planDeploymentChanges(smaller, events);
		expect(incremental.summary.retain).toBe(2);
		expect(incremental.converged).toBe(true);
		expect(
			planDeploymentChanges(smaller, events, "complete").summary.delete,
		).toBe(2);
		expect(orphansToPrune(smaller, events).ordered.map((r) => r.name)).toEqual([
			"web",
			"api",
		]);

		iac.calls.length = 0;
		const kept = await runOrchestrator(deps(store, iac), smaller, "modes", {
			tenant,
			actor,
		});
		expect(kept.pruned).toEqual([]);
		expect(iac.calls).toEqual([]);

		const pruned = await runOrchestrator(deps(store, iac), smaller, "modes", {
			tenant,
			actor,
			mode: "complete",
		});
		expect(pruned.status).toBe("deployed");
		expect(pruned.pruned).toEqual(["web", "api"]);
		expect(iac.calls).toEqual(["destroy:web", "destroy:api"]);
	});

	it("reports undeclared resources with no recorded plan as unprunable", async () => {
		const store = freshStore();
		const plan = loadPlan();
		await runOrchestrator(deps(store, recordingIac()), plan, "unknown", {
			tenant,
			actor,
		});
		const smaller = { ...plan, resources: plan.resources.slice(0, 1) };
		const events = await drain(store, "deployment:unknown");
		expect(orphansToPrune(smaller, events).unknown.length).toBe(
			plan.resources.length - 1,
		);
	});
});
