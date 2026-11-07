import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fromJson } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { HostingPlanningInputSchema } from "../src/_generated/hosting_planning_pb.js";
import { createHostingPlanningPass } from "../src/planner/hosting-budget.js";
import type { ResourceDefinition } from "../src/registry/catalog.js";

const definition: ResourceDefinition = {
	id: "a",
	providerId: "a",
	port: "compute",
	features: ["http"],
	regions: ["us"],
	specificity: 1,
	priority: 0,
	satisfies: () => ({ kind: "full" }),
};
const fixtures = [
	"valid-input",
	"invalid-component-bound",
	"invalid-missing-payer",
];
function fixtureUrl(name: string) {
	return new URL(
		`../contracts/hosting-budget-fixtures/${name}.json`,
		import.meta.url,
	);
}
function parse(name: string) {
	const wire = fromJson(
		HostingPlanningInputSchema,
		JSON.parse(readFileSync(fixtureUrl(name), "utf8")),
	);
	if (!wire.budget) throw new Error("fixture budget missing");
	return { ...wire, budget: wire.budget };
}

describe("hosting planning CUE and generated-record corpus", () => {
	it.each(fixtures)("checks actual record %s with CUE", (name) => {
		const cue =
			process.env.HOBO_CUE_BIN ??
			fileURLToPath(
				new URL(
					`../../../.tools/cue/v0.14.0/${process.platform === "win32" ? "cue.exe" : "cue"}`,
					import.meta.url,
				),
			);
		const result = spawnSync(
			cue,
			[
				"vet",
				"-d",
				"#HostingPlanningInput",
				fileURLToPath(
					new URL("../data-models/hosting_planning.cue", import.meta.url),
				),
				fileURLToPath(fixtureUrl(name)),
			],
			{ encoding: "utf8" },
		);
		if (result.error) throw result.error;
		expect(result.status, result.stderr).toBe(name === "valid-input" ? 0 : 1);
	});
	it("preserves payer attribution when the generated wire record is parsed", () => {
		const allocation = createHostingPlanningPass(parse("valid-input")).commit(
			"app",
			definition,
		);
		expect(allocation.providerCharges).toEqual([
			{ providerAccountId: "account:a", expectedMicros: 0, reservedMicros: 0 },
			{ providerAccountId: "source", expectedMicros: 50, reservedMicros: 60 },
		]);
	});
	it.each(
		fixtures.slice(1),
	)("refuses the same invalid corpus record %s at runtime", (name) => {
		expect(() =>
			createHostingPlanningPass(parse(name)).commit("app", definition),
		).toThrow();
	});
});
