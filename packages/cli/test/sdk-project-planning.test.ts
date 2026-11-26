import { bindle, collectBindleManifest } from "@hobo/bindles";
import {
	lowerManifest,
	type PlannerRegistry,
	plan,
	type ResourceDefinition,
} from "@hobo/cloud";
import { describe, expect, it } from "vitest";
import { targetFromBindleDefinition } from "../src/cloud/loader.js";

/** Test offerings model planner capabilities, not provider authorization. */
function definition(port: string, features: string[]): ResourceDefinition {
	return {
		id: `test.${port}`,
		providerId: "test",
		port,
		features,
		regions: ["global"],
		specificity: 1,
		priority: 0,
		cost: { sku: port, unit: "hour", marginalPrice: "1" },
		satisfies(request) {
			if (request.port !== port) return { kind: "none" };
			const missing = (request.features ?? []).filter(
				(feature) => !features.includes(feature),
			);
			return missing.length ? { kind: "partial", missing } : { kind: "full" };
		},
	};
}

function registry(...definitions: ResourceDefinition[]): PlannerRegistry {
	return {
		catalogHash: "project-test",
		definitions: () => definitions,
		providers: () => ["test"],
	};
}

describe("SDK project planning", () => {
	it("declares a project without a serving runtime", () => {
		const app = bindle("project-only", (b) => ({ project: b.project() }));
		expect(app.requirements.require).toEqual(["project"]);
		expect(app.requirements.runtimes).toEqual([]);
		expect(app.resources.project?.annotations).toEqual([]);
	});

	it("keeps a project distinct from an HTTP-serving web application", () => {
		const app = bindle("project-test", (b) => {
			const project = b.project();
			return { project, site: b.web().dependsOn(project) };
		});
		const { manifest } = collectBindleManifest(targetFromBindleDefinition(app));
		expect(manifest.value.resources.project).toMatchObject({
			type: "data.v1",
			paradigm: "project",
		});
		expect(manifest.value.resources.project?.connectionString).toBeUndefined();
		expect(manifest.value.resources.site?.links ?? []).not.toContainEqual({
			import: "hobo:data",
			to: "project",
		});
		expect(lowerManifest(manifest)).toMatchObject([
			{ name: "project", port: "project", require: [] },
			{ name: "site", port: "compute", require: ["http"], deps: ["project"] },
		]);

		const project = definition("project", []);
		const nonHttp = definition("compute", []);
		expect(plan(manifest, { deploymentId: "ci" }, registry(nonHttp)).ok).toBe(
			false,
		);
		expect(
			plan(manifest, { deploymentId: "ci" }, registry(project, nonHttp)).ok,
		).toBe(false);
		const accepted = plan(
			manifest,
			{ deploymentId: "ci" },
			registry(project, definition("compute", ["http"])),
		);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) throw new Error(accepted.reason);
		expect(
			accepted.plan.resources.find((row) => row.name === "project")?.port,
		).toBe("project");
	});

	it("preserves resource ordering and rejects references to missing resources", () => {
		const app = bindle("ordering", (b) => {
			const project = b.project();
			const cache = b.bucket().dependsOn(project);
			const api = b.api().dependsOn(project, cache);
			const queue = b.queue().dependsOn(api);
			return { project, cache, api, queue };
		});
		const target = targetFromBindleDefinition(app);
		const { manifest } = collectBindleManifest(target);
		expect(manifest.value.resources.cache?.bind).toEqual(["project"]);
		expect(manifest.value.resources.api?.bind).toEqual(["cache", "project"]);
		expect(manifest.value.resources.api?.links).toContainEqual({
			import: "hobo:data",
			to: "cache",
		});
		expect(manifest.value.resources.api?.links).not.toContainEqual({
			import: "hobo:data",
			to: "project",
		});
		expect(manifest.value.resources.queue?.bind).toEqual(["api"]);
		for (const missing of ["missing", "constructor"]) {
			expect(() =>
				collectBindleManifest({
					...target,
					dependencies: [{ from: "cache", to: missing }],
				}),
			).toThrow(/undeclared resource/u);
		}
	});
});
