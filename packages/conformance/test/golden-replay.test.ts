import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createConformanceSuite, runConformanceSuite } from "../src/index.ts";
import type { JsonValue } from "../src/json.js";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const foundationsFixture = JSON.parse(
	readFileSync(join(packageRoot, "fixtures/foundations-fixture.json"), "utf8"),
);
const witRuntimeFixture = JSON.parse(
	readFileSync(join(packageRoot, "fixtures/wit-runtime-fixture.json"), "utf8"),
);

function fixtureSuite(fixtureName: string, fixture: JsonValue) {
	return createConformanceSuite({
		id: `${fixtureName}-capture`,
		port: {
			wit: `hobo:fixture/${fixtureName}@0.1.0`,
			functions: ["capture"],
		},
		coverage: {
			requiredFunctions: ["capture"],
		},
		cases: [
			{
				id: `captures-${fixtureName}`,
				exercises: ["capture"],
				call: {
					function: "capture",
					input: { fixtureName },
				},
				expect: {
					output: fixture,
				},
			},
		],
	});
}

function fixtureAdapter(id: string, fixture: JsonValue) {
	return {
		id,
		async capture() {
			return {
				output: fixture,
				goldenIr: [],
				replayTrace: [{ function: "capture", output: fixture }],
			};
		},
	};
}

describe("golden fixture replay", () => {
	it("round-trips the foundations fixture", async () => {
		const report = await runConformanceSuite(
			fixtureSuite("foundations", foundationsFixture),
			fixtureAdapter("foundations-adapter", foundationsFixture),
			{ seed: "hobo-5-stable-seed" },
		);

		expect(report.ok).toBe(true);
		expect(report.claim.status).toBe("listed");
	});

	it("round-trips the wit-runtime fixture", async () => {
		const report = await runConformanceSuite(
			fixtureSuite("wit-runtime", witRuntimeFixture),
			fixtureAdapter("wit-runtime-adapter", witRuntimeFixture),
			{ seed: "hobo-5-stable-seed" },
		);

		expect(report.ok).toBe(true);
		expect(report.claim.status).toBe("listed");
	});

	it("catches a single-field mutation with exact JSON path", async () => {
		const mutatedAdapter = {
			id: "foundations-mutated",
			async capture() {
				const mutated = structuredClone(foundationsFixture);
				// SAFETY: assertion to `mutated as { workspace: string }` is required at this boundary.
				(mutated as { workspace: string }).workspace = "mutated workspace";

				return {
					output: mutated,
					goldenIr: [],
					replayTrace: [],
				};
			},
		};

		const report = await runConformanceSuite(
			fixtureSuite("foundations", foundationsFixture),
			mutatedAdapter,
			{ seed: "hobo-5-stable-seed" },
		);

		expect(report.ok).toBe(false);
		const mismatch = report.failures.find(
			(failure) => failure.code === "adapter.output-mismatch",
		);
		expect(mismatch?.diff?.path).toBe("$.workspace");
	});
});
