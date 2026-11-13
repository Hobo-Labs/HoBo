import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CiProjectDocumentSchema } from "../src/project-schema.js";
import { parseCiRunnerRouting } from "../src/relay-routing.js";
import {
	parseRunnerRouting,
	runnerRoutingLabels,
} from "../src/runner-routing.js";

const fixture = (name: string) =>
	readFileSync(
		new URL(`../data-models/fixtures/${name}`, import.meta.url),
		"utf8",
	);
const fixtures = (kind: "valid" | "invalid") =>
	readdirSync(new URL(`../data-models/fixtures/${kind}`, import.meta.url))
		.filter((name) => name.startsWith("runner-routing"))
		.sort();
const committed = readFileSync(
	new URL("../../../.hobo/ci.json", import.meta.url),
	"utf8",
);

describe("committed runner routing", () => {
	it("parses every valid fixture and no invalid one", () => {
		expect(fixtures("valid").length).toBeGreaterThan(0);
		expect(fixtures("invalid").length).toBeGreaterThan(0);
		for (const name of fixtures("valid"))
			expect(
				parseRunnerRouting(JSON.parse(fixture(`valid/${name}`))),
				name,
			).toBeDefined();
		for (const name of fixtures("invalid"))
			expect(
				parseRunnerRouting(JSON.parse(fixture(`invalid/${name}`))),
				name,
			).toBeUndefined();
	});

	it("is the block .hobo/ci.json commits, equal to the valid fixture", () => {
		expect(parseCiRunnerRouting(committed)).toEqual(
			JSON.parse(fixture("valid/runner-routing.json")),
		);
	});

	it("is part of the project document the editor schema describes", () => {
		expect(
			CiProjectDocumentSchema.parse(JSON.parse(committed)).runnerRouting,
		).toEqual(JSON.parse(fixture("valid/runner-routing.json")));
	});

	it("names the labels a routing slip may use", () => {
		const policy = parseCiRunnerRouting(committed);
		expect(policy && [...runnerRoutingLabels(policy)].sort()).toEqual([
			"hobo",
			"hobo-local-host",
			"hobo-trunk",
			"ubuntu-24.04",
		]);
	});

	it("is nothing for a file without the block or that is not JSON", () => {
		expect(parseCiRunnerRouting("{}")).toBeUndefined();
		expect(parseCiRunnerRouting("not json")).toBeUndefined();
		expect(parseCiRunnerRouting("[]")).toBeUndefined();
	});
});
