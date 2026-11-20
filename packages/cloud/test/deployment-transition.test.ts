import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventStore } from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, expect, it } from "vitest";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	type DeploymentPlan,
	deploymentPlanned,
	deploymentViewProjection,
	desiredSpecHash,
	type Executor,
	type IacProvider,
	reconcileResource,
	runCompensation,
	runOrchestrator,
} from "../src/index.js";
import { iacProgramFor } from "../src/orchestrator/resource-actor.js";

const actor = { kind: "service", id: "station" } as const;
const tenant = "tenant";
const deploymentId = "transition-test";
const resource = { name: "web", port: "compute", provider: "local", deps: [] };
const plan: DeploymentPlan = {
	schema: "hobo.deployment-plan/v1",
	objective: "min-cost",
	dependencyOrder: ["web"],
	resources: [resource],
};
const emptyPlan: DeploymentPlan = {
	...plan,
	dependencyOrder: [],
	resources: [],
};
const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "hobo-transition-"));
	dirs.push(dir);
	const store = createRuntimeLocalEventStore({ dataDir: dir });
	const calls: string[] = [];
	const iac: IacProvider = {
		id: "local",
		preview: async () => ({ summary: "preview", changes: 1 }),
		apply: async (program) => {
			calls.push(`apply:${program.resourceId}`);
			return {};
		},
		destroy: async (program) => {
			calls.push(`destroy:${program.resourceId}`);
		},
		refresh: async () => ({ drift: false, observed: {} }),
	};
	const deps = {
		store,
		actorHost: createInMemoryActorHost(),
		executor: createInProcessExecutor({ iac }),
		broker: createInProcessCredentialBroker(),
		verifyResume: async () => true,
	};
	return { store, calls, deps, context: { tenant, actor } };
}

async function events(store: EventStore) {
	const result = [];
	for await (const event of store.read(`deployment:${deploymentId}`))
		result.push(event);
	return result;
}

it("records rollback completion only after destruction and explicitly reopens a new run", async () => {
	const f = fixture();
	try {
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		const rollback = await runCompensation(
			f.deps,
			plan,
			deploymentId,
			{ resourceId: "web", reason: "test" },
			f.context,
		);
		expect(rollback.status).toBe("rolled-back");
		const types = rollback.events.map((event) => event.type);
		expect(types.indexOf("deployment.TransitionStarted")).toBeLessThan(
			types.indexOf("resource.Destroying"),
		);
		expect(types.indexOf("resource.Destroyed")).toBeLessThan(
			types.indexOf("deployment.TransitionCompleted"),
		);
		expect(types.indexOf("deployment.TransitionCompleted")).toBeLessThan(
			types.indexOf("deployment.RolledBack"),
		);
		await expect(
			reconcileResource(f.deps, resource, { ...f.context, deploymentId }),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
		const reopened = await runOrchestrator(
			f.deps,
			plan,
			deploymentId,
			f.context,
		);
		expect(reopened.status).toBe("deployed");
		const reopenedTypes = reopened.events.map((event) => event.type);
		expect(reopenedTypes.lastIndexOf("deployment.Reopened")).toBeGreaterThan(
			reopenedTypes.lastIndexOf("deployment.RolledBack"),
		);
		expect(reopenedTypes.lastIndexOf("deployment.Reopened")).toBeLessThan(
			reopenedTypes.lastIndexOf("resource.Provisioning"),
		);
		const view = await deploymentViewProjection.rebuildFromZero(
			f.store,
			`deployment:${deploymentId}`,
		);
		expect(deploymentViewProjection.get(view, deploymentId)).toMatchObject({
			status: "deployed",
		});
		expect(
			deploymentViewProjection.get(view, deploymentId)?.rollback,
		).toBeUndefined();
	} finally {
		f.store.close();
	}
});

it("binds a reopened run to its reviewed application specs", async () => {
	const f = fixture();
	const startSeen = deferred();
	const release = deferred();
	try {
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		await runCompensation(
			f.deps,
			plan,
			deploymentId,
			{ resourceId: "web", reason: "test" },
			f.context,
		);
		const wrapped: EventStore = {
			...f.store,
			async append(stream, batch, options) {
				if (batch.some((event) => event.type === "resource.Provisioning")) {
					startSeen.resolve();
					await release.promise;
				}
				return f.store.append(stream, batch, options);
			},
		};
		const deps = { ...f.deps, store: wrapped };
		const reopening = runOrchestrator(deps, plan, deploymentId, f.context);
		await startSeen.promise;
		await expect(
			reconcileResource(
				deps,
				{ ...resource, name: "rogue" },
				{ ...f.context, deploymentId },
			),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
		release.resolve();
		expect((await reopening).status).toBe("deployed");
	} finally {
		release.resolve();
		f.store.close();
	}
}, 20_000);

it("keeps rollback active after a crash and resumes the same transition", async () => {
	const f = fixture();
	try {
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		let crashed = false;
		const executor: Executor = {
			async run(program, credential, options) {
				if (program.action === "destroy" && !crashed) {
					crashed = true;
					throw new Error("worker crashed");
				}
				return f.deps.executor.run(program, credential, options);
			},
		};
		await expect(
			runCompensation(
				{ ...f.deps, executor },
				plan,
				deploymentId,
				{ resourceId: "web", reason: "test" },
				f.context,
			),
		).rejects.toThrow("worker crashed");
		const before = await events(f.store);
		expect(
			before.filter((event) => event.type === "deployment.TransitionStarted"),
		).toHaveLength(1);
		expect(before.some((event) => event.type === "deployment.RolledBack")).toBe(
			false,
		);
		const view = await deploymentViewProjection.rebuildFromZero(
			f.store,
			`deployment:${deploymentId}`,
		);
		expect(deploymentViewProjection.get(view, deploymentId)?.status).toBe(
			"rolling-back",
		);
		const changed = { ...plan, resources: [{ ...resource, region: "west" }] };
		expect(
			(await runOrchestrator(f.deps, changed, deploymentId, f.context)).status,
		).toBe("needs-human");
		await expect(
			reconcileResource(f.deps, resource, { ...f.context, deploymentId }),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
		const resumed = await runOrchestrator(
			f.deps,
			plan,
			deploymentId,
			f.context,
		);
		expect(resumed.status).toBe("rolled-back");
		expect(
			resumed.events.filter(
				(event) => event.type === "deployment.TransitionStarted",
			),
		).toHaveLength(1);
		expect(
			resumed.events.filter(
				(event) => event.type === "deployment.TransitionCompleted",
			),
		).toHaveLength(1);
	} finally {
		f.store.close();
	}
});

it("puts a legacy in-flight prune behind a new CAS barrier before resuming", async () => {
	const f = fixture();
	try {
		await f.store.append(
			`deployment:${deploymentId}`,
			[deploymentPlanned({ deploymentId, planHash: "sha256:test", plan })],
			{ expectedSeq: 0, tenant, actor },
		);
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		const prior = await events(f.store);
		const program = iacProgramFor(
			deploymentId,
			{ ...resource, deploymentId },
			"destroy",
			tenant,
		);
		await f.store.append(
			`deployment:${deploymentId}`,
			[
				{
					type: "resource.Destroying",
					data: {
						deploymentId,
						resourceId: "web",
						reason: "legacy",
						operationGeneration: randomUUID(),
						programHash: `sha256:${createHash("sha256").update(JSON.stringify(program)).digest("hex")}`,
						specHash: desiredSpecHash(resource),
					},
				},
			],
			{ expectedSeq: prior.at(-1)?.seq ?? 0, tenant, actor },
		);
		const executor: Executor = {
			async run(program, credential, options) {
				if (program.action === "destroy")
					expect(
						(await events(f.store)).some(
							(event) => event.type === "deployment.TransitionStarted",
						),
					).toBe(true);
				return f.deps.executor.run(program, credential, options);
			},
		};
		const resumed = await runOrchestrator(
			{ ...f.deps, executor },
			emptyPlan,
			deploymentId,
			{ ...f.context, mode: "complete" },
		);
		expect(resumed.status).toBe("deployed");
	} finally {
		f.store.close();
	}
});

it("resumes a crashed prune under the same barrier before applying anything else", async () => {
	const f = fixture();
	try {
		await f.store.append(
			`deployment:${deploymentId}`,
			[deploymentPlanned({ deploymentId, planHash: "sha256:test", plan })],
			{ expectedSeq: 0, tenant, actor },
		);
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		let crashed = false;
		const executor: Executor = {
			async run(program, credential, options) {
				if (program.action === "destroy" && !crashed) {
					crashed = true;
					throw new Error("worker crashed");
				}
				return f.deps.executor.run(program, credential, options);
			},
		};
		await expect(
			runOrchestrator({ ...f.deps, executor }, emptyPlan, deploymentId, {
				...f.context,
				mode: "complete",
			}),
		).rejects.toThrow("worker crashed");
		const resumed = await runOrchestrator(f.deps, emptyPlan, deploymentId, {
			...f.context,
			mode: "complete",
		});
		expect(resumed.status).toBe("deployed");
		expect(
			resumed.events.filter(
				(event) => event.type === "deployment.TransitionStarted",
			),
		).toHaveLength(1);
		expect(
			resumed.events.filter(
				(event) => event.type === "deployment.TransitionCompleted",
			),
		).toHaveLength(1);
	} finally {
		f.store.close();
	}
});

it("does not silently reopen an ambiguous legacy rollback", async () => {
	const f = fixture();
	try {
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		const before = await events(f.store);
		await f.store.append(
			`deployment:${deploymentId}`,
			[
				{
					type: "deployment.RolledBack",
					data: { deploymentId, targetSetId: "old", reason: "legacy" },
				},
			],
			{ expectedSeq: before.at(-1)?.seq ?? 0, tenant, actor },
		);
		const result = await runOrchestrator(f.deps, plan, deploymentId, f.context);
		expect(result.status).toBe("needs-human");
		expect(
			result.events.some((event) => event.type === "deployment.Reopened"),
		).toBe(false);
	} finally {
		f.store.close();
	}
});

it("can reopen a legacy rollback whose later destroy facts prove completion", async () => {
	const f = fixture();
	try {
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		const before = await events(f.store);
		await f.store.append(
			`deployment:${deploymentId}`,
			[
				{
					type: "deployment.RolledBack",
					data: { deploymentId, targetSetId: "old", reason: "legacy" },
				},
				{
					type: "resource.Destroying",
					data: { deploymentId, resourceId: "web", reason: "legacy" },
				},
				{
					type: "resource.Destroyed",
					data: { deploymentId, resourceId: "web", finalStateHash: "old" },
				},
			],
			{ expectedSeq: before.at(-1)?.seq ?? 0, tenant, actor },
		);
		const reopened = await runOrchestrator(
			f.deps,
			plan,
			deploymentId,
			f.context,
		);
		expect(reopened.status).toBe("deployed");
		expect(
			reopened.events.some((event) => event.type === "deployment.Reopened"),
		).toBe(true);
	} finally {
		f.store.close();
	}
});

it("can replay a legacy rollback and a previously completed legacy redeploy", async () => {
	const f = fixture();
	try {
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		const before = await events(f.store);
		await f.store.append(
			`deployment:${deploymentId}`,
			[
				{
					type: "deployment.RolledBack",
					data: { deploymentId, targetSetId: "old", reason: "legacy" },
				},
				{
					type: "resource.Destroying",
					data: { deploymentId, resourceId: "web", reason: "legacy" },
				},
				{
					type: "resource.Destroyed",
					data: { deploymentId, resourceId: "web", finalStateHash: "old" },
				},
				{
					type: "resource.Provisioning",
					data: {
						deploymentId,
						resourceId: "web",
						execId: "old",
						programHash: "old",
						providerId: "local",
						specHash: desiredSpecHash(resource),
					},
				},
				{
					type: "resource.Provisioned",
					data: {
						deploymentId,
						resourceId: "web",
						execId: "old",
						outputs: {},
						specHash: desiredSpecHash(resource),
					},
				},
				{
					type: "deployment.Deployed",
					data: { deploymentId, setId: "old", resourceIds: ["web"] },
				},
			],
			{ expectedSeq: before.at(-1)?.seq ?? 0, tenant, actor },
		);
		const result = await runOrchestrator(f.deps, plan, deploymentId, f.context);
		expect(result.status).toBe("deployed");
	} finally {
		f.store.close();
	}
});

it.each([
	false,
	true,
])("refuses to infer that an interrupted legacy redeploy is complete (terminal=%s)", async (terminal) => {
	const f = fixture();
	try {
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		const before = await events(f.store);
		await f.store.append(
			`deployment:${deploymentId}`,
			[
				{
					type: "deployment.RolledBack",
					data: { deploymentId, targetSetId: "old", reason: "legacy" },
				},
				{
					type: "resource.Destroying",
					data: { deploymentId, resourceId: "web", reason: "legacy" },
				},
				{
					type: "resource.Destroyed",
					data: { deploymentId, resourceId: "web", finalStateHash: "old" },
				},
				{
					type: "resource.Provisioning",
					data: {
						deploymentId,
						resourceId: "web",
						execId: "old",
						programHash: "old",
					},
				},
				...(terminal
					? [
							{
								type: "deployment.Deployed",
								data: { deploymentId, setId: "old", resourceIds: ["web"] },
							},
						]
					: []),
			],
			{ expectedSeq: before.at(-1)?.seq ?? 0, tenant, actor },
		);
		await expect(
			runOrchestrator(f.deps, plan, deploymentId, f.context),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
	} finally {
		f.store.close();
	}
});

it("rejects a completion that does not match the durable transition start", async () => {
	const f = fixture();
	try {
		const start = {
			deploymentId,
			transitionId: "11111111-1111-4111-8111-111111111111",
			kind: "prune",
			planHash: `sha256:${"a".repeat(64)}`,
			resourceIds: ["web"],
		};
		await f.store.append(
			`deployment:${deploymentId}`,
			[
				{ type: "deployment.TransitionStarted", data: start },
				{
					type: "deployment.TransitionCompleted",
					data: { ...start, planHash: `sha256:${"b".repeat(64)}` },
				},
			],
			{ expectedSeq: 0, tenant, actor },
		);
		await expect(
			runOrchestrator(f.deps, plan, deploymentId, f.context),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
		expect(f.calls).toEqual([]);
	} finally {
		f.store.close();
	}
});

it("rejects reuse of a completed transition identity", async () => {
	const f = fixture();
	try {
		const transition = {
			deploymentId,
			transitionId: "11111111-1111-4111-8111-111111111111",
			kind: "prune",
			planHash: `sha256:${"a".repeat(64)}`,
			resourceIds: [],
		};
		await f.store.append(
			`deployment:${deploymentId}`,
			[
				{ type: "deployment.TransitionStarted", data: transition },
				{ type: "deployment.TransitionCompleted", data: transition },
				{ type: "deployment.TransitionStarted", data: transition },
			],
			{ expectedSeq: 0, tenant, actor },
		);
		await expect(
			runOrchestrator(f.deps, emptyPlan, deploymentId, f.context),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
		expect(f.calls).toEqual([]);
	} finally {
		f.store.close();
	}
});

it("rejects a transition history that crossed an unresolved apply", async () => {
	const f = fixture();
	try {
		await f.store.append(
			`deployment:${deploymentId}`,
			[
				{
					type: "resource.Provisioning",
					data: {
						deploymentId,
						resourceId: "web",
						execId: "legacy",
						programHash: "legacy",
					},
				},
				{
					type: "deployment.TransitionStarted",
					data: {
						deploymentId,
						transitionId: "11111111-1111-4111-8111-111111111111",
						kind: "prune",
						planHash: `sha256:${"a".repeat(64)}`,
						resourceIds: ["web"],
					},
				},
			],
			{ expectedSeq: 0, tenant, actor },
		);
		await expect(
			runOrchestrator(f.deps, emptyPlan, deploymentId, {
				...f.context,
				mode: "complete",
			}),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
		expect(f.calls).toEqual([]);
	} finally {
		f.store.close();
	}
});

it("uses SQLite CAS to stop an apply that read before rollback started", async () => {
	const f = fixture();
	const startSeen = deferred();
	const releaseStart = deferred();
	const finishSeen = deferred();
	const releaseFinish = deferred();
	const wrapped: EventStore = {
		...f.store,
		async append(stream, batch, options) {
			if (batch.some((event) => event.type === "resource.Provisioning")) {
				startSeen.resolve();
				await releaseStart.promise;
			}
			if (
				batch.some((event) => event.type === "deployment.TransitionCompleted")
			) {
				finishSeen.resolve();
				await releaseFinish.promise;
			}
			return f.store.append(stream, batch, options);
		},
	};
	try {
		const deps = { ...f.deps, store: wrapped };
		const applying = reconcileResource(deps, resource, {
			...f.context,
			deploymentId,
		});
		await startSeen.promise;
		const rollback = runCompensation(
			deps,
			emptyPlan,
			deploymentId,
			{ resourceId: "failed", reason: "test" },
			f.context,
		);
		await finishSeen.promise;
		releaseStart.resolve();
		await expect(applying).rejects.toThrow();
		await expect(
			reconcileResource(deps, resource, { ...f.context, deploymentId }),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
		expect(f.calls).toEqual([]);
		releaseFinish.resolve();
		expect((await rollback).status).toBe("rolled-back");
	} finally {
		releaseStart.resolve();
		releaseFinish.resolve();
		f.store.close();
	}
}, 20_000);

it("refuses rollback while an apply start already won SQLite CAS", async () => {
	const f = fixture();
	const entered = deferred();
	const release = deferred();
	try {
		const executor: Executor = {
			async run(program, credential, options) {
				entered.resolve();
				await release.promise;
				return f.deps.executor.run(program, credential, options);
			},
		};
		const applying = reconcileResource({ ...f.deps, executor }, resource, {
			...f.context,
			deploymentId,
		});
		await entered.promise;
		const rollback = await runCompensation(
			f.deps,
			plan,
			deploymentId,
			{ resourceId: "failed", reason: "test" },
			f.context,
		);
		expect(rollback.status).toBe("needs-human");
		expect(
			rollback.events.some(
				(event) => event.type === "deployment.TransitionStarted",
			),
		).toBe(false);
		release.resolve();
		expect((await applying).kind).toBe("provisioned");
	} finally {
		release.resolve();
		f.store.close();
	}
}, 20_000);

it("uses the same CAS barrier for pruning before a stale apply can start", async () => {
	const f = fixture();
	const startSeen = deferred();
	const releaseStart = deferred();
	const destroySeen = deferred();
	const releaseDestroy = deferred();
	try {
		await f.store.append(
			`deployment:${deploymentId}`,
			[deploymentPlanned({ deploymentId, planHash: "sha256:test", plan })],
			{ expectedSeq: 0, tenant, actor },
		);
		await runOrchestrator(f.deps, plan, deploymentId, f.context);
		const wrapped: EventStore = {
			...f.store,
			async append(stream, batch, options) {
				if (batch.some((event) => event.type === "resource.Provisioning")) {
					startSeen.resolve();
					await releaseStart.promise;
				}
				return f.store.append(stream, batch, options);
			},
		};
		const executor: Executor = {
			async run(program, credential, options) {
				if (program.action === "destroy") {
					destroySeen.resolve();
					await releaseDestroy.promise;
				}
				return f.deps.executor.run(program, credential, options);
			},
		};
		const deps = { ...f.deps, store: wrapped, executor };
		const rogue = { ...resource, name: "rogue" };
		const applying = reconcileResource(deps, rogue, {
			...f.context,
			deploymentId,
		});
		await startSeen.promise;
		const pruning = runOrchestrator(deps, emptyPlan, deploymentId, {
			...f.context,
			mode: "complete",
		});
		await Promise.race([
			destroySeen.promise,
			pruning.then((result) => {
				throw new Error(`prune ended before destroy: ${result.status}`);
			}),
		]);
		releaseStart.resolve();
		await expect(applying).rejects.toThrow();
		await expect(
			reconcileResource(deps, rogue, { ...f.context, deploymentId }),
		).rejects.toMatchObject({ code: "DEPLOYMENT_TRANSITION_BLOCKED" });
		releaseDestroy.resolve();
		const completed = await pruning;
		expect(completed.status).toBe("deployed");
		const types = completed.events.map((event) => event.type);
		expect(types.indexOf("deployment.TransitionStarted")).toBeLessThan(
			types.indexOf("resource.Destroying"),
		);
		expect(types.indexOf("resource.Destroyed")).toBeLessThan(
			types.indexOf("deployment.TransitionCompleted"),
		);
	} finally {
		releaseStart.resolve();
		releaseDestroy.resolve();
		f.store.close();
	}
}, 20_000);
