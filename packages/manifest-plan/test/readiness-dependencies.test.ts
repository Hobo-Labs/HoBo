import { describe, expect, it } from "vitest";
import {
	canonicalPlanJson,
	DEPLOYMENT_PLAN_SCHEMA,
	parseDeploymentPlan,
	parseResourcePlan,
} from "../src/index.js";

const resource = {
	name: "api",
	port: "compute",
	provider: "local",
	deps: ["db", "migrate"],
	readyDeps: ["db"],
	completedDeps: ["migrate"],
};

describe("plan readiness dependencies", () => {
	it("preserves readiness conditions in canonical plan JSON", () => {
		const plan = parseDeploymentPlan({
			schema: DEPLOYMENT_PLAN_SCHEMA,
			resources: [resource],
			dependencyOrder: ["api"],
			objective: "min-cost",
		});
		expect(JSON.parse(canonicalPlanJson(plan)).resources[0]).toEqual(resource);
	});

	it("rejects invalid readiness conditions", () => {
		for (const readyDeps of [[], ["unknown"], ["db", "db"], ["migrate"]]) {
			expect(() => parseResourcePlan({ ...resource, readyDeps })).toThrow();
		}
	});
});
