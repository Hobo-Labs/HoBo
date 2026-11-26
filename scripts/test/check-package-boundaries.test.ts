/**
 * Regression guard for the boundary checker's import scan.
 *
 * The scan is a regex over source text, which means it cannot tell a real
 * `import … from "@hobo/x"` from one *quoted inside a string* — and a
 * remediation message that tells a human what to type is exactly that. One such
 * message in `@hobo/identity` ("import { createLocalStationOpenBaoSecretsPort }
 * from \"@hobo/adapter-openbao\"") was enough to invent an edge that made the
 * checker report a dependency cycle between two packages where only one
 * direction exists.
 *
 * The assertions below are about that class of mistake rather than about the
 * current graph: the real edge must still be found, the phantom reverse edge
 * must not be, and the checker must exit clean.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

interface Report {
	readonly edges: ReadonlyArray<{
		readonly from_path: string;
		readonly to_path: string;
	}>;
	readonly violations: ReadonlyArray<{ readonly rule: string }>;
}

type BoundaryRun = {
	readonly status: number | null;
	readonly report: Report;
};

function run(): BoundaryRun {
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", join(root, "scripts/check-package-boundaries.mts")],
		{ cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
	);
	const line = result.stdout
		.split("\n")
		.find((entry) => entry.trim().startsWith("{"));
	assert.ok(line, `no JSON report in output: ${result.stdout}${result.stderr}`);
	// SAFETY: assertion to `.parse(line) as Report }; ` is required at this boundary.
	return { status: result.status, report: JSON.parse(line) as Report };
}

describe("check-package-boundaries", () => {
	it("does not read an import quoted inside a string literal as a dependency", () => {
		const { status, report } = run();
		const has = (from: string, to: string): boolean =>
			report.edges.some(
				(edge) => edge.from_path === from && edge.to_path === to,
			);

		// The real dependency, declared in package.json and imported in source.
		assert.ok(
			has("packages/adapters/adapter-openbao", "packages/identity"),
			"the real adapter-openbao -> identity edge went missing",
		);
		// The phantom one, which exists only as text inside an error message.
		assert.ok(
			!has("packages/identity", "packages/adapters/adapter-openbao"),
			"a quoted import in a remediation message was counted as a dependency",
		);
		assert.deepEqual(report.violations, []);
		assert.equal(status, 0);
	});

	it("still finds ordinary imports, so the fix did not blind the scan", () => {
		const { report } = run();
		// Single-line, multi-line and re-export forms all appear in these.
		for (const [from, to] of [
			["packages/yards", "packages/core"],
			["packages/camps", "packages/bindles"],
			["packages/cloud-providers", "packages/providers/provider-azure"],
		] as const) {
			assert.ok(
				report.edges.some(
					(edge) => edge.from_path === from && edge.to_path === to,
				),
				`expected edge ${from} -> ${to}`,
			);
		}
		assert.ok(report.edges.length > 200, "the edge graph collapsed");
	});
});

/**
 * The dev-only harness exemption, on the real workspace rather than a fixture.
 *
 * `packages/packs/pack-framework` is a layer-2 adapter that lists
 * `@hobo/contract-harness` under `devDependencies` and imports it only from its
 * test suite. Under the strict layering rules that edge is a violation; it is
 * clean solely because the declared-dependency collector marks it `dev` and
 * `isDevOnlyTestHarnessEdge` exempts it. Nothing tested that end to end, so the
 * exemption could have been deleted, or the marker could have stopped being
 * set, with the only symptom being a gate that stayed green for a different
 * reason.
 */
describe("dev-only contract-harness edge", () => {
	it("is discovered, and exempted rather than absent", () => {
		const { status, report } = run();

		assert.ok(
			report.edges.some(
				(edge) =>
					edge.from_path === "packages/packs/pack-framework" &&
					edge.to_path === "packages/contract-harness",
			),
			"pack-framework -> contract-harness is missing from the graph, so a clean run proves nothing about the dev exemption",
		);
		assert.deepEqual(report.violations, []);
		assert.equal(status, 0);
	});

	it("reports one edge per package pair, so a dev sighting cannot be counted twice", () => {
		const { report } = run();
		const seen = new Set<string>();
		const duplicates: string[] = [];
		for (const edge of report.edges) {
			const key = `${edge.from_path}->${edge.to_path}`;
			if (seen.has(key)) duplicates.push(key);
			seen.add(key);
		}
		assert.deepEqual(
			duplicates,
			[],
			"mergeWorkspaceEdges must collapse the declared and source sightings of a pair into one edge; two rows means the dev marker is decided by whichever row a rule happens to read",
		);
	});
});
