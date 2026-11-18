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
	deploymentDeployed,
	deploymentPlanned,
	desiredSpecHash,
	type IacProgram,
	type IacProvider,
	type OrchestratorDeps,
	orphansToPrune,
	parseDeploymentMode,
	planDeploymentChanges,
	reconcileResource,
	resourceProvisioned,
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
	it("rechecks provider ownership under the resource lease before applying a stale plan", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		const resource = plan.resources[0];
		if (!resource) throw new Error("fixture has no resource");
		const runtime = deps(store, iac);
		await runOrchestrator(runtime, plan, "stale-plan", { tenant, actor });
		iac.calls.length = 0;
		const outcome = await reconcileResource(
			runtime,
			{ ...resource, provider: "different-provider" },
			{ deploymentId: "stale-plan", tenant, actor },
		);
		expect(outcome).toMatchObject({
			kind: "blocked",
			move: {
				resource: resource.name,
				from: resource.provider,
				to: "different-provider",
			},
		});
		expect(iac.calls).toEqual([]);
	});

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
	it("does not destroy the existing estate when an update crosses the no-go threshold", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await runOrchestrator(deps(store, iac), plan, "failed-update", {
			tenant,
			actor,
		});
		iac.calls.length = 0;
		const changed = {
			...plan,
			resources: plan.resources.map((r) =>
				r.name === "cache" ? { ...r, region: "new-region" } : r,
			),
		};
		const failing: IacProvider = {
			...iac,
			async apply(program) {
				if (program.resourceId === "cache") throw new Error("update failed");
				return {};
			},
		};
		const result = await runOrchestrator(
			deps(store, failing),
			changed,
			"failed-update",
			{
				tenant,
				actor,
				noGoThresholdResources: new Set(["cache"]),
			},
		);
		expect(result.status).toBe("needs-human");
		expect(iac.calls.filter((call) => call.startsWith("destroy:"))).toEqual([]);
	});

	it("detects later changes to legacy resources when their applied plan is recorded", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const fixture = loadPlan();
		const plan = {
			...fixture,
			resources: fixture.resources.filter((r) => r.name === "network"),
		};
		await recordPlan(store, "legacy-plan", plan);
		const stream = "deployment:legacy-plan";
		const events = await drain(store, stream);
		await emit(
			store,
			stream,
			[
				resourceProvisioned({
					deploymentId: "legacy-plan",
					resourceId: "network",
					outputs: {},
					execId: "legacy",
				}),
				deploymentDeployed({
					deploymentId: "legacy-plan",
					setId: "legacy-set",
					resourceIds: ["network"],
				}),
			],
			{ expectedSeq: events.at(-1)?.seq ?? 0, actor, tenant },
		);
		await runOrchestrator(deps(store, iac), plan, "legacy-plan", {
			tenant,
			actor,
		});
		expect(iac.calls).toEqual([]);

		const changed = {
			...plan,
			resources: plan.resources.map((r) => ({ ...r, region: "new-region" })),
		};
		await recordPlan(store, "legacy-plan", changed);
		const whatIf = planDeploymentChanges(changed, await drain(store, stream));
		expect(whatIf.changes[0]?.action).toBe("update");
		const result = await runOrchestrator(
			deps(store, iac),
			changed,
			"legacy-plan",
			{ tenant, actor },
		);
		expect(iac.calls).toEqual(["apply:network"]);
		expect(result.status).toBe("deployed");
	});

	it("sends the changed resource declaration to the provider", async () => {
		const store = freshStore();
		const recorded: IacProgram[] = [];
		const iac: IacProvider = {
			...recordingIac(),
			async apply(program) {
				recorded.push(program);
				return {};
			},
		};
		const plan = loadPlan();
		await runOrchestrator(deps(store, iac), plan, "provider-spec", {
			tenant,
			actor,
		});
		recorded.length = 0;
		const changed = {
			...plan,
			resources: plan.resources.map((r) =>
				r.name === "cache"
					? {
							...r,
							region: "new-region",
							productId: "new-product",
							realizationParameters: { size: "large" },
						}
					: r,
			),
		};
		const result = await runOrchestrator(
			deps(store, iac),
			changed,
			"provider-spec",
			{ tenant, actor },
		);
		expect(result.status).toBe("deployed");
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.resource).toMatchObject({
			name: "cache",
			region: "new-region",
			productId: "new-product",
			realizationParameters: { size: "large" },
		});
	});

	it("updates dependencies before their dependents even when the plan lists the dependent first", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await runOrchestrator(deps(store, iac), plan, "update-order", {
			tenant,
			actor,
		});
		iac.calls.length = 0;
		const changed = {
			...plan,
			resources: [...plan.resources]
				.reverse()
				.map((r) =>
					r.name === "api" || r.name === "database"
						? { ...r, region: "new-region" }
						: r,
				),
		};
		const result = await runOrchestrator(
			deps(store, iac),
			changed,
			"update-order",
			{ tenant, actor },
		);
		expect(result.status).toBe("deployed");
		expect(iac.calls).toEqual(["apply:database", "apply:api"]);
	});

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
				if (program.resourceId === "web")
					throw Object.assign(new Error("web down"), {
						requiresReconciliation: false,
						executionOutcome: "not-started",
					});
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
	it("does not delete an orphan involved in a dependency cycle", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const fixture = loadPlan();
		const template = fixture.resources[0];
		if (!template) throw new Error("missing fixture resource");
		const cyclic = {
			...fixture,
			resources: [
				{ ...template, name: "a", deps: ["b"] },
				{ ...template, name: "b", deps: ["a"] },
			],
		};
		await recordPlan(store, "orphan-cycle", cyclic);
		const stream = "deployment:orphan-cycle";
		const events = await drain(store, stream);
		await emit(
			store,
			stream,
			cyclic.resources.map((resource) =>
				resourceProvisioned({
					deploymentId: "orphan-cycle",
					resourceId: resource.name,
					outputs: {},
					execId: resource.name,
					specHash: desiredSpecHash(resource),
				}),
			),
			{ expectedSeq: events.at(-1)?.seq ?? 0, actor, tenant },
		);
		const result = await runOrchestrator(
			deps(store, iac),
			{ ...cyclic, resources: [] },
			"orphan-cycle",
			{ tenant, actor, mode: "complete" },
		);
		expect(result.status).toBe("waiting");
		expect(result.unprunable).toEqual(["a", "b"]);
		expect(iac.calls).toEqual([]);
	});

	it("does not guess which plan to destroy after a failed in-place update", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const fixture = loadPlan();
		const plan = {
			...fixture,
			resources: fixture.resources.filter((r) => r.name === "network"),
		};
		await recordPlan(store, "uncertain-update", plan);
		await runOrchestrator(deps(store, iac), plan, "uncertain-update", {
			tenant,
			actor,
		});
		const changed = {
			...plan,
			resources: plan.resources.map((r) => ({
				...r,
				region: "new-region",
			})),
		};
		await recordPlan(store, "uncertain-update", changed);
		const failing: IacProvider = {
			...iac,
			async apply() {
				throw new Error("partial update");
			},
		};
		const update = await runOrchestrator(
			deps(store, failing),
			changed,
			"uncertain-update",
			{ tenant, actor },
		);
		expect(update.status).toBe("needs-human");
		const retried = await runOrchestrator(
			deps(store, failing),
			changed,
			"uncertain-update",
			{ tenant, actor },
		);
		expect(retried.status).toBe("needs-human");
		iac.calls.length = 0;
		const result = await runOrchestrator(
			deps(store, iac),
			{ ...plan, resources: [] },
			"uncertain-update",
			{ tenant, actor, mode: "complete" },
		);
		expect(result.status).toBe("needs-human");
		expect(iac.calls).toEqual([]);
	});

	it("uses the applied plan when an unapplied later plan changes the provider", async () => {
		const store = freshStore();
		const destroyed: IacProgram[] = [];
		const iac: IacProvider = {
			...recordingIac(),
			async destroy(program) {
				destroyed.push(program);
			},
		};
		const fixture = loadPlan();
		const plan = {
			...fixture,
			resources: fixture.resources.filter((r) => r.name === "network"),
		};
		await recordPlan(store, "applied-plan", plan);
		await runOrchestrator(deps(store, iac), plan, "applied-plan", {
			tenant,
			actor,
		});
		await recordPlan(store, "applied-plan", {
			...plan,
			resources: plan.resources.map((r) => ({
				...r,
				provider: "unapplied-provider",
			})),
		});
		const result = await runOrchestrator(
			deps(store, iac),
			{ ...plan, resources: [] },
			"applied-plan",
			{ tenant, actor, mode: "complete" },
		);
		expect(result.status).toBe("deployed");
		expect(destroyed.map((program) => program.provider)).toEqual([
			plan.resources[0]?.provider,
		]);
	});

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

	it("keeps dependencies of a failed deletion and resumes pruning on retry", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await recordPlan(store, "prune-failure", plan);
		await runOrchestrator(deps(store, iac), plan, "prune-failure", {
			tenant,
			actor,
		});
		const smaller = {
			...plan,
			resources: plan.resources.filter(
				(r) => r.name !== "web" && r.name !== "api",
			),
		};
		iac.calls.length = 0;
		const failing: IacProvider = {
			...iac,
			async destroy(program) {
				iac.calls.push(`destroy:${program.resourceId}`);
				if (program.resourceId === "web")
					throw Object.assign(new Error("provider unavailable"), {
						requiresReconciliation: false,
						executionOutcome: "not-started",
					});
			},
		};
		const failed = await runOrchestrator(
			deps(store, failing),
			smaller,
			"prune-failure",
			{
				tenant,
				actor,
				mode: "complete",
			},
		);
		expect(iac.calls).toEqual(["destroy:web"]);
		expect(failed.status).toBe("waiting");
		expect(failed.unprunable).toEqual(["api", "web"]);
		expect(
			failed.events.filter((e) => e.type === "deployment.Deployed"),
		).toHaveLength(1);

		iac.calls.length = 0;
		const retried = await runOrchestrator(
			{ ...deps(store, iac), verifyResume: async () => true },
			smaller,
			"prune-failure",
			{
				tenant,
				actor,
				mode: "complete",
			},
		);
		expect(iac.calls).toEqual(["destroy:web", "destroy:api"]);
		expect(retried.status).toBe("deployed");
		expect(retried.unprunable).toEqual([]);
	});

	it("stops pruning and replay when an undeclared resource's deletion is uncertain", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await recordPlan(store, "uncertain-prune", plan);
		await runOrchestrator(deps(store, iac), plan, "uncertain-prune", {
			tenant,
			actor,
		});
		const smaller = {
			...plan,
			resources: plan.resources.filter(
				(r) => r.name !== "web" && r.name !== "api",
			),
		};
		iac.calls.length = 0;
		const uncertain: IacProvider = {
			...iac,
			async destroy(program) {
				iac.calls.push(`destroy:${program.resourceId}`);
				throw Object.assign(new Error("outcome unknown"), {
					requiresReconciliation: true,
					reservationId: "iac:prune",
				});
			},
		};
		const first = await runOrchestrator(
			deps(store, uncertain),
			smaller,
			"uncertain-prune",
			{ tenant, actor, mode: "complete" },
		);
		expect(first.status).toBe("needs-human");
		expect(iac.calls).toEqual(["destroy:web"]);
		const replay = await runOrchestrator(
			deps(store, uncertain),
			smaller,
			"uncertain-prune",
			{ tenant, actor, mode: "complete" },
		);
		expect(replay.status).toBe("needs-human");
		expect(iac.calls).toEqual(["destroy:web"]);
	});

	it("does not prune known resources when an orphan has no recorded dependencies", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await recordPlan(store, "unknown-deps", {
			...plan,
			resources: plan.resources.filter((r) => r.name !== "web"),
		});
		await runOrchestrator(deps(store, iac), plan, "unknown-deps", {
			tenant,
			actor,
		});
		iac.calls.length = 0;
		const result = await runOrchestrator(
			deps(store, iac),
			{
				...plan,
				resources: plan.resources.filter(
					(r) => r.name !== "web" && r.name !== "api",
				),
			},
			"unknown-deps",
			{ tenant, actor, mode: "complete" },
		);
		expect(iac.calls).toEqual([]);
		expect(result.status).toBe("waiting");
		expect(result.unprunable).toEqual(["api", "web"]);
	});

	it("does not prune a dependency still referenced by a declared resource", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await recordPlan(store, "declared-deps", plan);
		await runOrchestrator(deps(store, iac), plan, "declared-deps", {
			tenant,
			actor,
		});
		iac.calls.length = 0;
		const result = await runOrchestrator(
			deps(store, iac),
			{
				...plan,
				resources: plan.resources.filter((r) => r.name !== "api"),
			},
			"declared-deps",
			{ tenant, actor, mode: "complete" },
		);
		expect(iac.calls).toEqual([]);
		expect(result.status).toBe("waiting");
		expect(result.unprunable).toEqual(["api"]);
	});

	it("does not report a blocked update as deployed", async () => {
		const store = freshStore();
		const iac = recordingIac();
		const plan = loadPlan();
		await runOrchestrator(deps(store, iac), plan, "blocked-update", {
			tenant,
			actor,
		});
		iac.calls.length = 0;
		const result = await runOrchestrator(
			deps(store, iac),
			{
				...plan,
				resources: plan.resources.map((r) =>
					r.name === "web"
						? { ...r, deps: ["missing"], region: "new-region" }
						: r,
				),
			},
			"blocked-update",
			{ tenant, actor },
		);
		expect(iac.calls).toEqual([]);
		expect(result.status).toBe("waiting");
	});
});
