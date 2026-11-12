import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	loadDepsBuildTelemetry,
	parseDepsBuildTelemetry,
} from "../lib/deps-build-headroom.mts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");

const IMPORT_PATTERN =
	/^\s*(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s$,]+\s+from\s+)?["']([^"']+)["']/gm;

/** Every file the entry loads, following relative imports (`.js` names a `.ts` source). */
function importGraph(entry: string, seen = new Set<string>()): string[] {
	const absolute = resolve(entry);
	if (seen.has(absolute)) return [...seen];
	seen.add(absolute);
	for (const match of readFileSync(absolute, "utf8").matchAll(IMPORT_PATTERN)) {
		const specifier = match[1] ?? "";
		if (specifier.startsWith("node:")) continue;
		assert.ok(
			specifier.startsWith("."),
			`${absolute} imports the package ${specifier}, which a job has not installed yet`,
		);
		const target = fileURLToPath(
			new URL(specifier, pathToFileURL(`${dirname(absolute)}/`)),
		);
		importGraph(
			target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : target,
			seen,
		);
	}
	return [...seen];
}

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("scripts the deps layer job runs before any install", () => {
	// The job builds the image that holds node_modules, so nothing is installed
	// when these run. A package import fails there with ERR_MODULE_NOT_FOUND.
	for (const entry of [
		"scripts/ci/wait-deps-build-window.mts",
		"scripts/lib/deps-build-headroom.mts",
		"scripts/ci/deps-build-headroom-defaults.mts",
	])
		it(`${entry} loads node builtins and repository files only`, () => {
			const files = importGraph(join(REPO_ROOT, entry));
			assert.ok(files.length >= 2, entry);
		});
});

describe("deps build telemetry read without a schema library", () => {
	it("accepts what the worker's schema accepts", () => {
		assert.deepEqual(parseDepsBuildTelemetry("{}"), {});
		assert.deepEqual(
			parseDepsBuildTelemetry(
				'{"peakDockerInodes":180000,"peakDockerBytes":23622320128,"updatedAtMs":1}',
			),
			{
				peakDockerInodes: 180_000,
				peakDockerBytes: 23_622_320_128,
				updatedAtMs: 1,
			},
		);
	});

	it("refuses what the worker's schema refuses", () => {
		for (const text of [
			"",
			"not json",
			"null",
			"[]",
			'"text"',
			'{"peakDockerInodes":-1}',
			'{"peakDockerInodes":1.5}',
			'{"peakDockerBytes":"1"}',
			'{"updatedAtMs":null}',
			'{"peakDockerInodes":1,"extra":true}',
		])
			assert.equal(parseDepsBuildTelemetry(text), undefined, text);
	});

	it("falls back to no telemetry for a missing or unreadable file", () => {
		const root = mkdtempSync(join(tmpdir(), "deps-telemetry-"));
		roots.push(root);
		const path = join(root, "telemetry.json");
		const prior = process.env.HOBO_CI_DEPS_BUILD_TELEMETRY_PATH;
		process.env.HOBO_CI_DEPS_BUILD_TELEMETRY_PATH = path;
		try {
			assert.deepEqual(loadDepsBuildTelemetry(), {});
			writeFileSync(path, '{"peakDockerInodes":"many"}');
			assert.deepEqual(loadDepsBuildTelemetry(), {});
			writeFileSync(path, '{"peakDockerInodes":200000}');
			assert.deepEqual(loadDepsBuildTelemetry(), { peakDockerInodes: 200_000 });
		} finally {
			if (prior === undefined)
				delete process.env.HOBO_CI_DEPS_BUILD_TELEMETRY_PATH;
			else process.env.HOBO_CI_DEPS_BUILD_TELEMETRY_PATH = prior;
		}
	});
});
