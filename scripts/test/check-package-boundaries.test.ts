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
	return { status: result.status, report: JSON.parse(line) as Report };
}

describe("check-package-boundaries", () => {
	it("does not read an import quoted inside a string literal as a dependency", () => {
		const { status, report } = run();
		const has = (from: string, to: string): boolean =>
			report.edges.some(
				(edge) => edge.from_path === from && edge.to_path === to,
			);

		assert.ok(
			has("packages/adapters/adapter-openbao", "packages/identity"),
			"the real adapter-openbao -> identity edge went missing",
		);
		assert.ok(
			!has("packages/identity", "packages/adapters/adapter-openbao"),
			"a quoted import in a remediation message was counted as a dependency",
		);
		assert.deepEqual(report.violations, []);
		assert.equal(status, 0);
	});

	it("still finds ordinary imports, so the fix did not blind the scan", () => {
		const { report } = run();
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
