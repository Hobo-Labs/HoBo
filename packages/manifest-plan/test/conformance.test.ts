import { describe, expect, it } from "vitest";

import {
	DEPLOYMENT_PLAN_SCHEMA,
	type DeploymentPlan,
	DeploymentPlanError,
	type PlanParseInput,
	parseDeploymentPlan,
	parseResourcePlan,
	type ResourcePlan,
	ResourcePlanError,
} from "../src/index.js";

/**
 * Conformance suite for the parse boundary.
 *
 * Every assertion names the refusal it means. A bare `.toThrow()` — or a
 * matcher loose enough that a *different* refusal from the same function
 * satisfies it — is how this repo has shipped tests that passed whether or not
 * the behaviour they named existed, so each case here pins the error class,
 * the code, and the exact field path.
 */

interface PlanFixture {
	[key: string]: PlanParseInput | undefined;
}

const node = (over: PlanFixture = {}): PlanFixture => ({
	name: "sessions",
	port: "kv",
	provider: "@hobo/provider-cloudflare",
	deps: [],
	...over,
});

const plan = (over: PlanFixture = {}): PlanFixture => ({
	schema: DEPLOYMENT_PLAN_SCHEMA,
	resources: [node()],
	dependencyOrder: ["sessions"],
	objective: "min-cost",
	...over,
});

function refusal(
	fn: () => ResourcePlan | DeploymentPlan,
): ResourcePlanError | DeploymentPlanError {
	try {
		fn();
	} catch (error) {
		if (
			error instanceof ResourcePlanError ||
			error instanceof DeploymentPlanError
		) {
			return error;
		}
		throw error;
	}
	throw new Error("expected a refusal, but the call returned");
}

describe("parseResourcePlan: required fields", () => {
	it.each([
		["name", "resource.name"],
		["port", "resource.port"],
		["provider", "resource.provider"],
	])("refuses a missing %s", (field, path) => {
		const input = node();
		delete input[field];
		const error = refusal(() => parseResourcePlan(input));
		expect(error).toBeInstanceOf(ResourcePlanError);
		expect(error.code).toBe("INVALID_RESOURCE_PLAN");
		expect(error.path).toBe(path);
		expect(error.message).toContain("expected a string, received undefined");
	});

	it.each(["name", "port", "provider"])("refuses an empty %s", (field) => {
		const error = refusal(() => parseResourcePlan(node({ [field]: "" })));
		expect(error.path).toBe(`resource.${field}`);
		expect(error.message).toContain("expected a non-empty string");
	});

	it("refuses an absent deps, distinguishing it from an empty one", () => {
		const input = node();
		delete input.deps;
		const error = refusal(() => parseResourcePlan(input));
		expect(error.path).toBe("resource.deps");
		expect(error.message).toContain("absent and empty hash differently");
		// The empty array is fine — only absence is refused.
		expect(parseResourcePlan(node({ deps: [] })).deps).toEqual([]);
	});

	it("refuses a non-string dep entry, naming its index", () => {
		const error = refusal(() => parseResourcePlan(node({ deps: ["a", 7] })));
		expect(error.path).toBe("resource.deps[1]");
		expect(error.message).toContain("expected a string, received number 7");
	});
});

describe("parseResourcePlan: optional fields under exactOptionalPropertyTypes", () => {
	it.each([
		"strategy",
		"region",
		"deploymentId",
		"productId",
	])("refuses %s present holding undefined", (field) => {
		const error = refusal(() =>
			parseResourcePlan(node({ [field]: undefined })),
		);
		expect(error.path).toBe(`resource.${field}`);
		expect(error.message).toContain(
			"an optional field must be absent, not empty-valued",
		);
		expect(error.message).toContain("present holding undefined");
	});

	it.each([
		"strategy",
		"region",
		"deploymentId",
		"productId",
	])("refuses %s present holding null", (field) => {
		const error = refusal(() => parseResourcePlan(node({ [field]: null })));
		expect(error.path).toBe(`resource.${field}`);
		expect(error.message).toContain("present holding null");
	});

	it("omits an absent optional rather than setting it to undefined", () => {
		const parsed = parseResourcePlan(node());
		for (const field of ["strategy", "region", "deploymentId", "productId"]) {
			expect(Object.hasOwn(parsed, field)).toBe(false);
		}
		expect(Object.keys(parsed).sort()).toEqual([
			"deps",
			"name",
			"port",
			"provider",
		]);
	});

	it("admits an empty strategy/region/deploymentId, matching the constraint it was decomposed from", () => {
		const parsed = parseResourcePlan(
			node({ strategy: "", region: "", deploymentId: "" }),
		);
		expect(parsed.strategy).toBe("");
		expect(parsed.region).toBe("");
		expect(parsed.deploymentId).toBe("");
	});

	it("refuses an empty productId, which the constraint does pin", () => {
		const error = refusal(() => parseResourcePlan(node({ productId: "" })));
		expect(error.path).toBe("resource.productId");
		expect(error.message).toContain("expected a non-empty string");
	});
});

describe("parseResourcePlan: realization parameters", () => {
	it.each([
		"apiToken",
		"API_KEY",
		"dbPassword",
		"clientSecret",
		"private_key",
		"credentialRef",
	])("refuses the credential-shaped key %s", (key) => {
		const error = refusal(() =>
			parseResourcePlan(node({ realizationParameters: { [key]: "x" } })),
		);
		expect(error.path).toBe(`resource.realizationParameters.${key}`);
		expect(error.message).toContain(
			"realization parameters carry locators, never credential values",
		);
	});

	it("admits a key that merely contains a credential word as a substring of a longer word only when the pattern does not match", () => {
		// `tier` and `ttlSeconds` are locators; neither matches the pattern.
		const parsed = parseResourcePlan(
			node({ realizationParameters: { tier: "standard", ttlSeconds: 3600 } }),
		);
		expect(parsed.realizationParameters).toEqual({
			tier: "standard",
			ttlSeconds: 3600,
		});
	});

	it("carries nested JSON values without flattening them to strings", () => {
		const parsed = parseResourcePlan(
			node({
				realizationParameters: {
					limits: { cpu: 2, memory: null, flags: [true, "x"] },
				},
			}),
		);
		expect(parsed.realizationParameters).toEqual({
			limits: { cpu: 2, memory: null, flags: [true, "x"] },
		});
	});

	it("refuses a non-finite number, which JSON.stringify would silently turn into null", () => {
		const error = refusal(() =>
			parseResourcePlan(node({ realizationParameters: { ratio: Number.NaN } })),
		);
		expect(error.path).toBe("resource.realizationParameters.ratio");
		expect(error.message).toContain("would canonicalize to null");
	});

	it("refuses a parameter holding undefined, which JSON.stringify would silently drop", () => {
		const error = refusal(() =>
			parseResourcePlan(node({ realizationParameters: { tier: undefined } })),
		);
		expect(error.path).toBe("resource.realizationParameters.tier");
		expect(error.message).toContain("would never reach the plan digest");
	});

	it("refuses a function-valued parameter", () => {
		const error = refusal(() =>
			parseResourcePlan(
				node({ realizationParameters: { at: () => undefined } }),
			),
		);
		expect(error.path).toBe("resource.realizationParameters.at");
		expect(error.message).toContain("expected a JSON value");
	});

	it("refuses a Date, which would walk to {} while JSON.stringify emits a string", () => {
		// Found by this suite: `typeof new Date(0) === "object"` and it has no own
		// enumerable keys, so a naive record walk silently yields `{}` — a parsed
		// value that disagrees with the bytes that get hashed.
		const error = refusal(() =>
			parseResourcePlan(node({ realizationParameters: { at: new Date(0) } })),
		);
		expect(error.path).toBe("resource.realizationParameters.at");
		expect(error.message).toContain(
			"expected a plain JSON object, received an instance of Date",
		);
	});

	it("refuses a class instance for the same reason", () => {
		class Limits {
			readonly cpu = 2;
		}
		const error = refusal(() =>
			parseResourcePlan(
				node({ realizationParameters: { limits: new Limits() } }),
			),
		);
		expect(error.path).toBe("resource.realizationParameters.limits");
		expect(error.message).toContain("an instance of Limits");
	});

	it("admits a null-prototype object, which is still a plain JSON record", () => {
		const bare: PlanFixture = Object.create(null);
		bare.tier = "standard";
		const parsed = parseResourcePlan(
			node({ realizationParameters: { limits: bare } }),
		);
		expect(parsed.realizationParameters).toEqual({
			limits: { tier: "standard" },
		});
	});

	it("refuses an empty nonPortableRows entry", () => {
		const error = refusal(() =>
			parseResourcePlan(node({ nonPortableRows: ["kv/a", ""] })),
		);
		expect(error.path).toBe("resource.nonPortableRows[1]");
		expect(error.message).toContain("expected a non-empty string");
	});
});

describe("parseResourcePlan: unknown fields", () => {
	it("refuses a field this schema does not carry", () => {
		const error = refusal(() => parseResourcePlan(node({ costCeiling: 12 })));
		expect(error.path).toBe("resource.costCeiling");
		expect(error.message).toContain("unknown field");
		expect(error.message).toContain("change the plan digest");
	});

	it("refuses a non-object node", () => {
		const error = refusal(() => parseResourcePlan(["sessions"]));
		expect(error.path).toBe("resource");
		expect(error.message).toContain("expected an object, received an array");
	});
});

describe("parseDeploymentPlan", () => {
	it("refuses a schema discriminant it does not own", () => {
		const error = refusal(() =>
			parseDeploymentPlan(plan({ schema: "hobo.deployment-plan/v2" })),
		);
		expect(error).toBeInstanceOf(DeploymentPlanError);
		expect(error.code).toBe("INVALID_DEPLOYMENT_PLAN");
		expect(error.path).toBe("plan.schema");
		expect(error.message).toContain('expected "hobo.deployment-plan/v1"');
	});

	it("refuses duplicate resource names, naming the second occurrence", () => {
		const error = refusal(() =>
			parseDeploymentPlan(
				plan({ resources: [node(), node({ port: "objectStore" })] }),
			),
		);
		expect(error.path).toBe("plan.resources[1].name");
		expect(error.message).toContain('duplicate resource name "sessions"');
	});

	it("propagates a node fault with the node's index in the path", () => {
		const error = refusal(() =>
			parseDeploymentPlan(
				plan({ resources: [node(), node({ name: "assets", port: 5 })] }),
			),
		);
		expect(error).toBeInstanceOf(ResourcePlanError);
		expect(error.path).toBe("plan.resources[1].port");
	});

	it("refuses an empty objective", () => {
		const error = refusal(() => parseDeploymentPlan(plan({ objective: "" })));
		expect(error.path).toBe("plan.objective");
		expect(error.message).toContain("expected a non-empty string");
	});

	it("refuses an absent dependencyOrder", () => {
		const input = plan();
		delete input.dependencyOrder;
		const error = refusal(() => parseDeploymentPlan(input));
		expect(error.path).toBe("plan.dependencyOrder");
		expect(error.message).toContain("required field is absent");
	});

	it("refuses an unknown plan-level field", () => {
		const error = refusal(() => parseDeploymentPlan(plan({ planHash: "x" })));
		expect(error.path).toBe("plan.planHash");
		expect(error.message).toContain("unknown field");
	});

	it("freezes the parsed plan, so a digest cannot be taken and then invalidated", () => {
		const parsed = parseDeploymentPlan(plan());
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.resources)).toBe(true);
		expect(Object.isFrozen(parsed.resources[0])).toBe(true);
	});
});

describe("what this boundary deliberately admits", () => {
	/**
	 * These are not oversights. Each is a property the producing planner does
	 * not hold either (packages/cloud/src/planner/plan.ts), so refusing it here
	 * would reject plans the system emits today. They are pinned so that a
	 * later decision to tighten the plan contract is a visible change to these
	 * tests rather than a silent widening somewhere else.
	 */
	it("admits a dependencyOrder that is not a topological order", () => {
		// plan.ts: "A cycle would leave nodes unordered; append any stragglers
		// deterministically" — a cyclic manifest yields exactly this shape.
		const parsed = parseDeploymentPlan(
			plan({
				resources: [
					node({ name: "a", deps: ["b"] }),
					node({ name: "b", deps: ["a"] }),
				],
				dependencyOrder: ["a", "b"],
			}),
		);
		expect(parsed.dependencyOrder).toEqual(["a", "b"]);
	});

	it("admits a dep naming a resource outside the plan", () => {
		// plan.ts: `if (!names.has(dep)) continue;` — an unknown dep is skipped
		// when the order is computed, never rejected.
		const parsed = parseDeploymentPlan(
			plan({ resources: [node({ deps: ["not-in-this-plan"] })] }),
		);
		expect(parsed.resources[0]?.deps).toEqual(["not-in-this-plan"]);
	});

	it("admits an empty dep id, matching the constraint it was decomposed from", () => {
		expect(parseResourcePlan(node({ deps: [""] })).deps).toEqual([""]);
	});
});
