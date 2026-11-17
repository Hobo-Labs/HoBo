import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryActorHost } from "@hobo/data";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { afterEach, expect, it } from "vitest";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
	destroyResource,
	type Executor,
	type IacProvider,
	type ResourcePlan,
	reconcileResource,
} from "../src/index.js";
import { isJsonObject } from "../src/json.js";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function fixture() {
	const path = mkdtempSync(join(tmpdir(), "hobo-operation-generation-"));
	paths.push(path);
	const store = createRuntimeLocalEventStore({ dataDir: path });
	const calls: { action: string; generation: string | undefined }[] = [];
	const provider: IacProvider = {
		id: "local",
		preview: async () => ({ summary: "preview", changes: 1 }),
		apply: async (program) => {
			calls.push({
				action: program.action,
				generation: program.operationGeneration,
			});
			return { endpoint: "example" };
		},
		destroy: async (program) => {
			calls.push({
				action: program.action,
				generation: program.operationGeneration,
			});
		},
		refresh: async () => ({ drift: false, observed: {} }),
	};
	const executor = createInProcessExecutor({ iac: provider });
	const deps = {
		store,
		executor,
		actorHost: createInMemoryActorHost(),
		broker: createInProcessCredentialBroker(),
	};
	const resource: ResourcePlan = {
		name: "api",
		port: "compute",
		provider: "local",
		deps: [],
	};
	const ctx = {
		tenant: "tenant",
		deploymentId: "deployment",
		actor: { kind: "service", id: "station" } as const,
	};
	return { store, calls, executor, deps, resource, ctx };
}

it("persists distinct generations for update, destroy and recreate", async () => {
	const f = fixture();
	try {
		expect((await reconcileResource(f.deps, f.resource, f.ctx)).kind).toBe(
			"provisioned",
		);
		const revised = { ...f.resource, region: "west" };
		expect((await reconcileResource(f.deps, revised, f.ctx)).kind).toBe(
			"updated",
		);
		expect((await destroyResource(f.deps, revised, f.ctx)).kind).toBe(
			"destroyed",
		);
		expect((await reconcileResource(f.deps, revised, f.ctx)).kind).toBe(
			"provisioned",
		);
		const starts = [];
		for await (const event of f.store.read("deployment:deployment"))
			if (
				event.type === "resource.Provisioning" ||
				event.type === "resource.Destroying"
			)
				starts.push(event);
		const recorded = starts.map((event) =>
			isJsonObject(event.data) ? event.data.operationGeneration : undefined,
		);
		expect(recorded).toEqual(f.calls.map((call) => call.generation));
		expect(recorded).toHaveLength(4);
		expect(recorded).toEqual(expect.arrayContaining([expect.any(String)]));
		expect(new Set(recorded).size).toBe(4);
	} finally {
		f.store.close();
	}
});

it.each([
	"apply",
	"destroy",
] as const)("reuses the durable %s generation after a crash", async (action) => {
	const f = fixture();
	try {
		if (action === "destroy")
			await reconcileResource(f.deps, f.resource, f.ctx);
		const observed: (string | undefined)[] = [];
		let fail = true;
		const crashOnce: Executor = {
			async run(program, credential, options) {
				observed.push(program.operationGeneration);
				if (fail) {
					fail = false;
					throw new Error("simulated crash");
				}
				return f.executor.run(program, credential, options);
			},
		};
		const deps = {
			...f.deps,
			executor: crashOnce,
			verifyResume: async () => true,
		};
		const run = () =>
			action === "apply"
				? reconcileResource(deps, f.resource, f.ctx)
				: destroyResource(deps, f.resource, f.ctx);
		await expect(run()).rejects.toThrow("simulated crash");
		await run();
		expect(observed).toHaveLength(2);
		expect(observed[0]).toEqual(expect.any(String));
		expect(observed[1]).toBe(observed[0]);
		const starts = [];
		for await (const event of f.store.read("deployment:deployment"))
			if (
				event.type ===
				(action === "apply" ? "resource.Provisioning" : "resource.Destroying")
			)
				starts.push(event);
		expect(starts).toHaveLength(1);
	} finally {
		f.store.close();
	}
});

it.each([
	"apply",
	"destroy",
] as const)("does not retry a possibly completed %s without a verified resume guarantee", async (action) => {
	const f = fixture();
	try {
		if (action === "destroy")
			await reconcileResource(f.deps, f.resource, f.ctx);
		const losesAck: Executor = {
			async run(program, credential, options) {
				await f.executor.run(program, credential, options);
				throw new Error("lost acknowledgement");
			},
		};
		const attempt =
			action === "apply"
				? reconcileResource(
						{ ...f.deps, executor: losesAck },
						f.resource,
						f.ctx,
					)
				: destroyResource({ ...f.deps, executor: losesAck }, f.resource, f.ctx);
		await expect(attempt).rejects.toThrow("lost acknowledgement");
		const calls = f.calls.length;
		const retry =
			action === "apply"
				? await reconcileResource(f.deps, f.resource, f.ctx)
				: await destroyResource(f.deps, f.resource, f.ctx);
		expect(retry.snapshot.state).toBe("ReconciliationRequired");
		expect(f.calls).toHaveLength(calls);
	} finally {
		f.store.close();
	}
});

it("blocks a changed or legacy in-flight operation for reconciliation before executing it", async () => {
	const f = fixture();
	try {
		const crashed: Executor = {
			run: async () => {
				throw new Error("crashed");
			},
		};
		await expect(
			reconcileResource({ ...f.deps, executor: crashed }, f.resource, f.ctx),
		).rejects.toThrow("crashed");
		const changed = await reconcileResource(
			f.deps,
			{ ...f.resource, region: "changed" },
			f.ctx,
		);
		expect(changed).toMatchObject({
			kind: "reconciliation-required",
			snapshot: { state: "ReconciliationRequired" },
		});
		expect(f.calls).toHaveLength(0);
	} finally {
		f.store.close();
	}
	const legacy = fixture();
	try {
		await legacy.store.append(
			"deployment:deployment",
			[
				{
					type: "resource.Provisioning",
					data: {
						deploymentId: "deployment",
						resourceId: "api",
						execId: "legacy",
						programHash: "old",
						providerId: "local",
					},
				},
			],
			{ expectedSeq: 0, tenant: "tenant", actor: legacy.ctx.actor },
		);
		const result = await reconcileResource(
			legacy.deps,
			legacy.resource,
			legacy.ctx,
		);
		expect(result).toMatchObject({
			kind: "reconciliation-required",
			snapshot: { state: "ReconciliationRequired" },
		});
		expect(legacy.calls).toHaveLength(0);
	} finally {
		legacy.store.close();
	}
});

it.each([
	"apply",
	"destroy",
] as const)("blocks the opposite action after a lost %s acknowledgement", async (action) => {
	const f = fixture();
	try {
		if (action === "destroy")
			await reconcileResource(f.deps, f.resource, f.ctx);
		const losesAck: Executor = {
			async run(program, credential, options) {
				await f.executor.run(program, credential, options);
				throw new Error("lost provider acknowledgement");
			},
		};
		const interrupted = { ...f.deps, executor: losesAck };
		const attempt =
			action === "apply"
				? reconcileResource(interrupted, f.resource, f.ctx)
				: destroyResource(interrupted, f.resource, f.ctx);
		await expect(attempt).rejects.toThrow("lost provider acknowledgement");
		const before = f.calls.length;
		const opposite =
			action === "apply"
				? await destroyResource(f.deps, f.resource, f.ctx)
				: await reconcileResource(f.deps, f.resource, f.ctx);
		expect(opposite.snapshot.state).toBe("ReconciliationRequired");
		expect(f.calls).toHaveLength(before);
	} finally {
		f.store.close();
	}
});
