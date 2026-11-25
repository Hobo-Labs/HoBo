import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { declaredFields, fieldNames } from "./fixtures/declared-fields.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function read(relativePath: string): string {
	return readFileSync(`${REPO_ROOT}${relativePath}`, "utf8");
}

const REQUIREMENT = read("packages/manifest-capability/src/requirement.ts");
const CANDIDATE = read("packages/manifest-request/src/candidate.ts");
const SELECTION = read("packages/capability-profiles/src/selection.ts");
const PLAN_TYPES = read("packages/manifest-plan/src/index.ts");
const PLACEMENT = read("packages/cloud/src/planner/placement.ts");
const OWN_SOURCE = read("packages/manifest-declaration/src/index.ts");

describe("ResourceIntent against the capability requirement", () => {
	it("shares not one field name with CapabilityRequirement", () => {
		const intent = new Set(
			fieldNames(declaredFields(OWN_SOURCE, "ResourceIntent")),
		);
		const requirement = new Set(
			fieldNames(declaredFields(REQUIREMENT, "CapabilityRequirement")),
		);
		expect(intent.size).toBe(10);
		expect(requirement.size).toBe(9);
		expect([...intent].filter((field) => requirement.has(field))).toEqual([]);
	});

	it("shares not one field name with SelectionCandidate either", () => {
		const intent = new Set(
			fieldNames(declaredFields(OWN_SOURCE, "ResourceIntent")),
		);
		const candidate = new Set(
			fieldNames(declaredFields(CANDIDATE, "SelectionCandidate")),
		);
		expect(candidate.size).toBeGreaterThan(10);
		expect([...intent].filter((field) => candidate.has(field))).toEqual([]);
	});
});

describe("the field that cannot be projected", () => {
	it("the placement vocabulary appears nowhere in the request manifest", () => {
		for (const token of [
			"anti-affinity",
			"targetPort",
			"pickN",
			"spread",
			"objective",
			"deps",
		]) {
			expect(REQUIREMENT).not.toContain(token);
			expect(CANDIDATE).not.toContain(token);
			expect(SELECTION).not.toContain(token);
		}
		for (const token of ["anti-affinity", "targetPort", "pickN", "spread"]) {
			expect(OWN_SOURCE).toContain(token);
		}
	});

	it("the request manifest's evaluator has no channel for a sibling node", () => {
		expect(fieldNames(declaredFields(SELECTION, "SelectionInput"))).toEqual([
			"requirement",
			"registry",
			"candidates",
			"policy",
			"nowMs",
			"consumableBindingProfiles",
		]);

		expect(PLACEMENT).toContain("export interface PlacementContext {");
		expect(fieldNames(declaredFields(PLACEMENT, "DecidedPlacement"))).toEqual([
			"resource",
			"port",
			"providerId",
			"region",
		]);
	});

	it("selection deliberately has no objective, so `objective` has nowhere to go", () => {
		expect(SELECTION).toContain(
			"There is deliberately no weighted score here.",
		);
	});
});

describe("what a projection would still have to carry", () => {
	it("names the graph identity and edges the plan is built from", () => {
		const intent = fieldNames(declaredFields(OWN_SOURCE, "ResourceIntent"));
		expect(intent).toContain("name");
		expect(intent).toContain("deps");
		expect(PLAN_TYPES).toContain("dependencyOrder");
	});

	it("is confirmed by the only intents in the repository with real edges", () => {
		const manifest = JSON.parse(
			read("packages/cloud/test/fixtures/hello-bindle.manifest.json"),
		) as { resources: Record<string, { bind?: string[] }> };
		expect(manifest.resources.service?.bind).toEqual(["sessions", "assets"]);
		for (const bound of manifest.resources.service?.bind ?? []) {
			expect(Object.keys(manifest.resources)).toContain(bound);
		}
	});
});
