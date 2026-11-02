/**
 * Drift as a derived fact.
 *
 * Written before the implementation. The whole claim of HOBO-819 is that HoBo
 * already holds both halves of the comparison — the plan is recorded intent,
 * the resource lifecycle facts are materialized reality — and simply never
 * derives the difference. If that claim is true, drift needs no new state, no
 * new event, and no reconciler: it is a pure function of a DeploymentViewRow.
 *
 * These tests encode the classification rules, and the rules exist to avoid the
 * failure mode this category is known for: false drift. A surface that cries
 * wolf gets ignore-globs bolted on until it hides the real thing. So:
 *
 *   - in-flight is not drift. A resource mid-provision is the plan being
 *     carried out, not a divergence from it.
 *   - the classification keys on typed lifecycle states, never on a field-level
 *     diff of arbitrary payloads (ADR-0136's typed contracts are the better
 *     basis, and field globs are exactly what accumulates into blindness).
 *   - a deployment with no plan yet is `unknown`, not `in-sync`. Reporting
 *     "no drift" for something never planned is the most dangerous answer of
 *     the three.
 */
import { describe, expect, it } from "vitest";

import {
	computeDrift,
	type DriftFinding,
} from "../src/projections/drift-view.js";
import type {
	DeploymentViewRow,
	ResourceLifecycle,
} from "../src/projections/deployment-view.js";
import { DEPLOYMENT_PLAN_SCHEMA } from "../src/plan-types.js";

function row(overrides: Partial<DeploymentViewRow> = {}): DeploymentViewRow {
	return {
		deploymentId: "d1",
		status: "deployed",
		decisions: [],
		resources: {},
		...overrides,
	};
}

function plan(...names: string[]) {
	return {
		schema: DEPLOYMENT_PLAN_SCHEMA,
		dependencyOrder: names,
		objective: "cost",
		resources: names.map((name) => ({
			name,
			port: "http",
			provider: "local",
			deps: [],
		})),
	};
}

const kinds = (findings: readonly DriftFinding[]) =>
	findings.map((f) => `${f.kind}:${f.resource}`).sort();

describe("a deployment with no plan", () => {
	it("is unknown rather than in-sync", () => {
		// Never say "no drift" about something we have not planned. That reads as
		// a clean bill of health for a deployment nobody has described.
		const report = computeDrift(row({ status: "requested" }));
		expect(report.status).toBe("unknown");
		expect(report.findings).toEqual([]);
	});

	it("is unknown even when resources exist without a plan", () => {
		const report = computeDrift(
			row({ status: "requested", resources: { web: "provisioned" } }),
		);
		expect(report.status).toBe("unknown");
	});
});

describe("a plan fully realized", () => {
	it("is in sync when every planned resource is provisioned", () => {
		const report = computeDrift(
			row({
				plan: plan("web", "db"),
				resources: { web: "provisioned", db: "provisioned" },
			}),
		);
		expect(report.status).toBe("in-sync");
		expect(report.findings).toEqual([]);
	});
});

describe("in-flight work is not drift", () => {
	it.each<ResourceLifecycle>([
		"provisioning",
		"destroying",
	])("treats %s as converging, not diverged", (lifecycle) => {
		const report = computeDrift(
			row({ plan: plan("web"), resources: { web: lifecycle } }),
		);
		expect(report.status).toBe("converging");
		expect(report.findings).toEqual([]);
	});

	it("reports converging when some resources are settled and others are not", () => {
		const report = computeDrift(
			row({
				plan: plan("web", "db"),
				resources: { web: "provisioned", db: "provisioning" },
			}),
		);
		expect(report.status).toBe("converging");
	});

	it("prefers a real divergence over an in-flight one", () => {
		// A failure is actionable now; an in-flight resource may still succeed.
		// Reporting "converging" here would bury the failure until it settles.
		const report = computeDrift(
			row({
				plan: plan("web", "db"),
				resources: { web: "failed", db: "provisioning" },
			}),
		);
		expect(report.status).toBe("out-of-sync");
		expect(kinds(report.findings)).toEqual(["failed:web"]);
	});
});

describe("planned but absent", () => {
	it("reports a planned resource with no lifecycle fact at all", () => {
		const report = computeDrift(row({ plan: plan("web"), resources: {} }));
		expect(report.status).toBe("out-of-sync");
		expect(kinds(report.findings)).toEqual(["absent:web"]);
	});

	it("reports a planned resource that was destroyed", () => {
		const report = computeDrift(
			row({ plan: plan("web"), resources: { web: "destroyed" } }),
		);
		expect(report.status).toBe("out-of-sync");
		expect(kinds(report.findings)).toEqual(["destroyed:web"]);
	});

	it("reports a planned resource whose provisioning failed", () => {
		const report = computeDrift(
			row({ plan: plan("web"), resources: { web: "failed" } }),
		);
		expect(kinds(report.findings)).toEqual(["failed:web"]);
	});
});

describe("present but unplanned", () => {
	it("reports a provisioned resource the plan does not declare", () => {
		// The case that matters most: something exists that nobody asked for.
		const report = computeDrift(
			row({
				plan: plan("web"),
				resources: { web: "provisioned", mystery: "provisioned" },
			}),
		);
		expect(report.status).toBe("out-of-sync");
		expect(kinds(report.findings)).toEqual(["unplanned:mystery"]);
	});

	it("does not report an unplanned resource that is already destroyed", () => {
		// Gone is gone. Flagging it forever is precisely the noise that trains
		// people to stop reading the report.
		const report = computeDrift(
			row({
				plan: plan("web"),
				resources: { web: "provisioned", old: "destroyed" },
			}),
		);
		expect(report.status).toBe("in-sync");
		expect(report.findings).toEqual([]);
	});

	it("reports an unplanned resource that is still being provisioned", () => {
		const report = computeDrift(
			row({
				plan: plan("web"),
				resources: { web: "provisioned", mystery: "provisioning" },
			}),
		);
		expect(kinds(report.findings)).toEqual(["unplanned:mystery"]);
	});
});

describe("an imported deployment", () => {
	it("does not treat pre-existing resources as unplanned", () => {
		// `hobo import` adopts an estate HoBo did not create. Every adopted
		// resource would otherwise read as drift on the first run, which would
		// make the feature useless exactly where it is most needed.
		const report = computeDrift(
			row({
				imported: true,
				plan: plan("web"),
				resources: { web: "provisioned", adopted: "provisioned" },
			}),
		);
		expect(report.status).toBe("in-sync");
	});

	it("still reports a planned resource that is absent", () => {
		// Adoption excuses extra resources, never missing ones.
		const report = computeDrift(
			row({ imported: true, plan: plan("web"), resources: {} }),
		);
		expect(kinds(report.findings)).toEqual(["absent:web"]);
	});
});

describe("a rolled-back deployment", () => {
	it("is not measured for drift", () => {
		// Its resources are meant to be gone; comparing them to the plan reports
		// a divergence that is the intended end state.
		const report = computeDrift(
			row({ status: "rolled-back", plan: plan("web"), resources: {} }),
		);
		expect(report.status).toBe("unknown");
		expect(report.findings).toEqual([]);
	});
});

describe("a rejected deployment", () => {
	it("is not measured for drift", () => {
		const report = computeDrift(
			row({ status: "rejected", plan: plan("web"), resources: {} }),
		);
		expect(report.status).toBe("unknown");
	});
});

describe("finding detail", () => {
	it("carries the resource name, its lifecycle and a human reason", () => {
		const [finding] = computeDrift(
			row({ plan: plan("web"), resources: { web: "failed" } }),
		).findings;
		expect(finding).toMatchObject({
			kind: "failed",
			resource: "web",
			lifecycle: "failed",
		});
		expect(finding?.detail).toContain("web");
	});

	it("reports absent findings with no lifecycle, since none was recorded", () => {
		const [finding] = computeDrift(
			row({ plan: plan("web"), resources: {} }),
		).findings;
		expect(finding?.kind).toBe("absent");
		expect(finding?.lifecycle).toBeUndefined();
	});

	it("orders findings by resource name, so the report is stable", () => {
		const report = computeDrift(
			row({ plan: plan("c", "a", "b"), resources: {} }),
		);
		expect(report.findings.map((f) => f.resource)).toEqual(["a", "b", "c"]);
	});

	it("is a pure function — the same row always yields the same report", () => {
		const input = row({
			plan: plan("web", "db"),
			resources: { web: "failed", extra: "provisioned" },
		});
		expect(computeDrift(input)).toEqual(computeDrift(input));
	});

	it("does not mutate the row it was given", () => {
		const input = row({
			plan: plan("web"),
			resources: { web: "provisioned" },
		});
		const before = structuredClone(input);
		computeDrift(input);
		expect(input).toEqual(before);
	});
});

describe("summary counts", () => {
	it("counts planned, realized and diverged resources", () => {
		const report = computeDrift(
			row({
				plan: plan("web", "db", "cache"),
				resources: { web: "provisioned", db: "failed", extra: "provisioned" },
			}),
		);
		expect(report.summary).toEqual({
			planned: 3,
			realized: 1,
			findings: 3, // db failed, cache absent, extra unplanned
		});
	});

	it("counts zero findings for a clean deployment", () => {
		const report = computeDrift(
			row({ plan: plan("web"), resources: { web: "provisioned" } }),
		);
		expect(report.summary).toEqual({ planned: 1, realized: 1, findings: 0 });
	});
});
