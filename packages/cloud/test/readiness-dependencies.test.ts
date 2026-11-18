import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	addContainer,
	compileBindleManifest,
	manifestFromWiring,
} from "@hobo/bindles";
import { createInMemoryActorHost } from "@hobo/data";
import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { describe, expect, it } from "vitest";
import {
	createInProcessCredentialBroker,
	createInProcessExecutor,
} from "../src/executor/executor.js";
import { lowerManifest } from "../src/intent.js";
import { desiredSpecHash } from "../src/orchestrator/desired-state.js";
import { runOrchestrator } from "../src/orchestrator/orchestrator.js";
import { plan } from "../src/planner/plan.js";
import type { PlannerRegistry } from "../src/registry/catalog.js";

const registry: PlannerRegistry = {
	catalogHash: "sha256:test",
	providers: () => ["local"],
	definitions: () => [
		{
			id: "local.compute",
			providerId: "local",
			port: "compute",
			features: ["http"],
			regions: ["local"],
			specificity: 1,
			priority: 1,
			cost: { sku: "local", unit: "request", marginalPrice: "0" },
			satisfies: () => ({ kind: "full" }),
		},
	],
};

function manifest() {
	const db = addContainer("db", "oci://example/db");
	const migrate = addContainer("migrate", "oci://example/migrate");
	const api = addContainer("api", "oci://example/api");
	if (!api.waitFor || !api.waitForCompletion)
		throw new Error("missing dependency methods");
	api.waitFor(db);
	api.waitForCompletion(migrate);
	return manifestFromWiring(compileBindleManifest([db, migrate, api]), {
		kind: "wasmtime",
		version: "46.0.1",
	});
}

describe("readiness-gated deployment", () => {
	it("carries authored conditions through planning and waits for observations", async () => {
		const result = plan(manifest(), { deploymentId: "shop" }, registry);
		if (!result.ok) throw new Error(result.reason);
		const api = result.plan.resources.find(
			(resource) => resource.name === "api",
		);
		if (!api) throw new Error("missing api plan");
		expect(api).toMatchObject({
			deps: ["db", "migrate"],
			readyDeps: ["db"],
			completedDeps: ["migrate"],
		});
		expect(desiredSpecHash(api)).not.toBe(
			desiredSpecHash({
				name: api.name,
				port: api.port,
				provider: api.provider,
				deps: api.deps,
			}),
		);
		const dir = await mkdtemp(path.join(tmpdir(), "hobo-readiness-"));
		const store = createRuntimeLocalEventStore({
			dataDir: dir,
			clock: createManualClock(),
		});
		const applied: string[] = [];
		const executor = createInProcessExecutor({
			iac: {
				id: "local",
				async preview() {
					return { summary: "apply", changes: 1 };
				},
				async apply(program) {
					applied.push(program.resourceId);
					return {};
				},
				async destroy() {},
				async refresh() {
					return { drift: false, observed: {} };
				},
			},
		});
		const deps = {
			store,
			executor,
			actorHost: createInMemoryActorHost(),
			broker: createInProcessCredentialBroker(),
		};
		const context = {
			tenant: "shop",
			actor: { kind: "service" as const, id: "orchestrator" },
		};
		try {
			const waiting = await runOrchestrator(deps, result.plan, "shop", context);
			expect(waiting.status).toBe("waiting");
			expect(waiting.blockedDependencies).toContainEqual({
				resource: "api",
				dependency: "db",
				condition: "ready",
				status: "unobserved",
			});
			expect(applied).toEqual(["db", "migrate"]);
			const pending = await runOrchestrator(
				{
					...deps,
					observeDependency: async ({ condition }) =>
						condition === "ready" ? "ready" : "pending",
				},
				result.plan,
				"shop",
				context,
			);
			expect(pending.status).toBe("waiting");
			expect(pending.blockedDependencies).toContainEqual({
				resource: "api",
				dependency: "migrate",
				condition: "completed",
				status: "pending",
			});
			const deployed = await runOrchestrator(
				{
					...deps,
					observeDependency: async ({ condition }) => condition,
				},
				result.plan,
				"shop",
				context,
			);
			expect(deployed.status).toBe("deployed");
			expect(applied).toEqual(["db", "migrate", "api"]);
		} finally {
			store.close();
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("rejects readiness references to missing resources", () => {
		const api = addContainer("api", "oci://example/api");
		api.waitFor?.("missing");
		const input = manifestFromWiring(compileBindleManifest([api]), {
			kind: "wasmtime",
			version: "46.0.1",
		});
		expect(() => lowerManifest(input)).toThrow(/invalid waitFor dependency/u);
	});
});
