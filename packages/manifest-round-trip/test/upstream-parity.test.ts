/**
 * Where a shape moved, the package it left must re-export it rather than keep
 * a second declaration that can drift.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { declaredFields } from "./declared-fields.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relative: string): string =>
	readFileSync(`${REPO_ROOT}${relative}`, "utf8");

const PLAN_TYPES = read("packages/cloud/src/plan-types.ts");
const MANIFEST_PLAN = read("packages/manifest-plan/src/index.ts");

describe("ResourceIntent moved and is re-exported", () => {
	it("plan-types.ts no longer declares it and names its owner", () => {
		expect(() => declaredFields(PLAN_TYPES, "ResourceIntent")).toThrow(
			/no exported declaration named ResourceIntent/u,
		);
		expect(PLAN_TYPES).toContain('} from "@hobo/manifest-declaration";');
		// The placement vocabulary moved with it; a partial move would leave
		// `PlacementCriteria` declared here and referring to a type that is not.
		for (const name of [
			"PlacementCriteria",
			"PlacementPropertySelector",
			"PlacementAffinityRule",
			"PlacementSpread",
			"PlacementPickN",
		]) {
			expect(() => declaredFields(PLAN_TYPES, name)).toThrow(
				DeclarationNotFoundMessage(name),
			);
			expect(PLAN_TYPES).toContain(`type ${name},`);
		}
	});

	it("the authoring type it re-exports is the unbranded one", () => {
		// `@hobo/cloud` builds intents with object literals and assigns
		// `intent.region` after construction. Re-exporting `ParsedResourceIntent`
		// under the name `ResourceIntent` would compile here and break there, so
		// the two names are pinned as distinct re-exports.
		expect(PLAN_TYPES).toMatch(/^\ttype ResourceIntent,$/mu);
		expect(PLAN_TYPES).toMatch(/^\ttype ParsedResourceIntent,$/mu);
	});
});

function DeclarationNotFoundMessage(name: string): RegExp {
	return new RegExp(`no exported declaration named ${name}`, "u");
}

describe("ResourcePlan and DeploymentPlan have one owner", () => {
	it.each([
		"ResourcePlan",
		"DeploymentPlan",
	])("cloud re-exports the %s authoring shape instead of declaring it", (name) => {
		expect(() => declaredFields(PLAN_TYPES, name)).toThrow(
			DeclarationNotFoundMessage(name),
		);
		expect(PLAN_TYPES).toContain(`${name}Authoring as ${name},`);
		expect(MANIFEST_PLAN).toContain(`export interface ${name}Authoring`);
	});
});
