import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@hobo/core";
import { createInMemoryActorHost } from "@hobo/data";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, describe, expect, it } from "vitest";
import { iacExecutionId } from "../src/executor/executor.js";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	type DeploymentPlan,
	deploymentPlanned,
	desiredSpecHash,
	destroyResource,
	type IacProvider,
	reconcileResource,
	resourceProvisioned,
	runCompensation,
	runOrchestrator,
} from "../src/index.js";
import { iacProgramFor } from "../src/orchestrator/resource-actor.js";

const deploymentId = "pending-deployment";
const actor = { kind: "service", id: "station" } as const;
const tenant = "tenant-a";
const dependency = {
	name: "network",
	port: "network",
	provider: "local",
	deps: [],
};
const child = {
	name: "web",
	port: "compute",
	provider: "local",
	deps: ["network"],
};
const plan: DeploymentPlan = {
	schema: "hobo.deployment-plan/v1",
	objective: "min-cost",
	dependencyOrder: ["network", "web"],
	resources: [dependency, child],
};
const smaller: DeploymentPlan = {
	...plan,
	dependencyOrder: ["network"],
	resources: [dependency],
};
const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const path = mkdtempSync(join(tmpdir(), "hobo-pending-effects-"));
	paths.push(path);
	const store = createRuntimeLocalEventStore({ dataDir: path });
	const calls: string[] = [];
	const provider: IacProvider = {
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
		executor: createInProcessExecutor({ iac: provider }),
		broker: createInProcessCredentialBroker(),
	};
	const context = { tenant, actor };
	let seq = 0;
	const append = async (events: EventInput[], owner = tenant) => {
		const result = await store.append(`deployment:${deploymentId}`, events, {
			expectedSeq: seq,
			tenant: owner,
			actor,
		});
		seq = result.seq;
	};
	return { store, calls, deps, context, append };
}

function pending(action: "apply" | "destroy"): EventInput {
	const program = iacProgramFor(
		deploymentId,
		{ ...child, deploymentId },
		action,
		tenant,
	);
	const operationGeneration = randomUUID();
	const programHash = `sha256:${createHash("sha256").update(JSON.stringify(program)).digest("hex")}`;
	const execId = iacExecutionId({ ...program, operationGeneration });
	return {
		type: action === "apply" ? "resource.Provisioning" : "resource.Destroying",
		data: {
			deploymentId,
			resourceId: child.name,
			operationGeneration,
			programHash,
			specHash: desiredSpecHash(child),
			providerId: child.provider,
			...(action === "apply" ? { execId } : { reason: "test" }),
		},
	};
}

async function seedPending(
	f: ReturnType<typeof fixture>,
	action: "apply" | "update" | "destroy",
) {
	await f.append([
		deploymentPlanned({ deploymentId, planHash: "sha256:test", plan }),
		resourceProvisioned({
			deploymentId,
			resourceId: dependency.name,
			outputs: {},
			execId: "prior-network",
			specHash: desiredSpecHash(dependency),
		}),
		...(action === "apply"
			? []
			: [
					resourceProvisioned({
						deploymentId,
						resourceId: child.name,
						outputs: {},
						execId: "prior-web",
						specHash: desiredSpecHash(child),
					}),
				]),
		pending(action === "destroy" ? "destroy" : "apply"),
	]);
}

describe("orchestration with pending provider effects", () => {
	it.each([
		"apply",
		"update",
		"destroy",
	] as const)("blocks an omitted in-flight %s before incremental success", async (action) => {
		const f = fixture();
		try {
			await seedPending(f, action);
			const result = await runOrchestrator(
				f.deps,
				smaller,
				deploymentId,
				f.context,
			);
			expect(result.status).toBe("needs-human");
			expect(result.pendingOperations).toContainEqual(
				expect.objectContaining({
					resourceId: "web",
					reason: "removed-from-plan",
				}),
			);
			expect(
				result.events.some((event) => event.type === "deployment.Deployed"),
			).toBe(false);
			expect(f.calls).toEqual([]);
		} finally {
			f.store.close();
		}
	});

	it.each([
		"apply",
		"update",
		"destroy",
	] as const)("does not prune or compensate dependencies of an omitted in-flight %s", async (action) => {
		const f = fixture();
		try {
			await seedPending(f, action);
			const result = await runOrchestrator(
				f.deps,
				{ ...smaller, dependencyOrder: [], resources: [] },
				deploymentId,
				{ ...f.context, mode: "complete" },
			);
			expect(result.status).toBe("needs-human");
			expect(f.calls).toEqual([]);
			const compensated = await runCompensation(
				f.deps,
				smaller,
				deploymentId,
				{ resourceId: "failed", reason: "test" },
				f.context,
			);
			expect(compensated.status).toBe("needs-human");
			expect(
				compensated.events.some(
					(event) => event.type === "deployment.RolledBack",
				),
			).toBe(false);
			expect(f.calls).toEqual([]);
		} finally {
			f.store.close();
		}
	});

	it.each([
		"apply",
		"update",
	] as const)("does not compensate an in-flight %s declared by the current plan", async (action) => {
		const f = fixture();
		try {
			await seedPending(f, action);
			const result = await runCompensation(
				f.deps,
				plan,
				deploymentId,
				{ resourceId: "failed", reason: "test" },
				f.context,
			);
			expect(result.status).toBe("needs-human");
			expect(
				result.events.some((event) => event.type === "deployment.RolledBack"),
			).toBe(false);
			expect(f.calls).toEqual([]);
		} finally {
			f.store.close();
		}
	});

	it("refuses a changed in-flight application before updating its dependency", async () => {
		const f = fixture();
		try {
			await seedPending(f, "apply");
			const changed = {
				...plan,
				resources: [
					{ ...dependency, region: "west" },
					{ ...child, region: "west" },
				],
			};
			const result = await runOrchestrator(
				f.deps,
				changed,
				deploymentId,
				f.context,
			);
			expect(result.status).toBe("needs-human");
			expect(f.calls).toEqual([]);
		} finally {
			f.store.close();
		}
	});

	it("refuses a dependency change even when the pending application itself is unchanged", async () => {
		const f = fixture();
		try {
			await seedPending(f, "apply");
			const changed = {
				...plan,
				resources: [{ ...dependency, region: "west" }, child],
			};
			const result = await runOrchestrator(
				f.deps,
				changed,
				deploymentId,
				f.context,
			);
			expect(result.status).toBe("needs-human");
			expect(result.pendingOperations).toContainEqual({
				resourceId: "web",
				operation: "apply",
				reason: "dependency-unverified",
			});
			expect(f.calls).toEqual([]);
		} finally {
			f.store.close();
		}
	});

	it("treats a desired resource whose destruction is in flight as an opposite operation", async () => {
		const f = fixture();
		try {
			await seedPending(f, "destroy");
			const result = await runOrchestrator(
				f.deps,
				plan,
				deploymentId,
				f.context,
			);
			expect(result.status).toBe("needs-human");
			expect(result.pendingOperations).toContainEqual({
				resourceId: "web",
				operation: "destroy",
				reason: "opposite-operation",
			});
			expect(f.calls).toEqual([]);
		} finally {
			f.store.close();
		}
	});

	it("requires the host to verify that an in-flight apply can safely resume", async () => {
		const f = fixture();
		try {
			await seedPending(f, "apply");
			const blocked = await runOrchestrator(
				f.deps,
				plan,
				deploymentId,
				f.context,
			);
			expect(blocked.status).toBe("needs-human");
			expect(blocked.pendingOperations).toContainEqual({
				resourceId: "web",
				operation: "apply",
				reason: "resume-unverified",
			});
			expect(f.calls).toEqual([]);
			const resumed = await runOrchestrator(
				{ ...f.deps, verifyResume: () => true },
				plan,
				deploymentId,
				f.context,
			);
			expect(resumed.status).toBe("deployed");
			expect(f.calls).toEqual(["apply:web"]);
		} finally {
			f.store.close();
		}
	});
});

describe("deployment stream ownership", () => {
	it.each([
		"tenant",
		"deployment",
	] as const)("rejects mismatched %s before no-op, destroy, orchestration or compensation", async (mismatch) => {
		const f = fixture();
		try {
			await f.append(
				[
					resourceProvisioned({
						deploymentId: mismatch === "deployment" ? "other" : deploymentId,
						resourceId: dependency.name,
						outputs: {},
						execId: "prior",
						specHash: desiredSpecHash(dependency),
					}),
				],
				mismatch === "tenant" ? "tenant-b" : tenant,
			);
			const direct = { ...f.context, deploymentId };
			for (const run of [
				() => reconcileResource(f.deps, dependency, direct),
				() => destroyResource(f.deps, dependency, direct),
				() => runOrchestrator(f.deps, smaller, deploymentId, f.context),
				() =>
					runCompensation(
						f.deps,
						smaller,
						deploymentId,
						{ resourceId: "failed", reason: "test" },
						f.context,
					),
			])
				await expect(run()).rejects.toMatchObject({
					code: "DEPLOYMENT_HISTORY_SCOPE_MISMATCH",
				});
			expect(f.calls).toEqual([]);
		} finally {
			f.store.close();
		}
	});
});
