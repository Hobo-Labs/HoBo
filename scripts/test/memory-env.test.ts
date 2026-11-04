import { spawnSync } from "node:child_process";
import {
	globSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect } from "vitest";
import {
	computeJobMemoryConfig,
	jobMemoryEnvLines,
	resolveJobMemoryLimitMb,
} from "../ci/memory-env.mts";

const temporaryDirectories: string[] = [];
afterEach(() => {
	for (const path of temporaryDirectories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("job memory environment", () => {
	it("sizes workers, heap, and turbo from a 4647 MiB job", () => {
		const config = computeJobMemoryConfig({ limitMb: 4647, cpuCount: 8 });
		expect(config).toEqual({
			heapMb: 1293,
			turboConcurrency: 1,
			vitestMaxWorkers: 2,
		});
		expect(jobMemoryEnvLines(config)).toEqual([
			"HOBO_NODE_OPTIONS=--max-old-space-size=1293",
			"HOBO_TURBO_CONCURRENCY=1",
			"HOBO_TEST_MAX_WORKERS=2",
		]);
		const root = fileURLToPath(new URL("../..", import.meta.url));
		for (const workflow of [
			"hobo-ci.yml",
			"pricing-ci.yml",
			"release-code.yml",
			"release-pricing.yml",
		])
			expect(
				readFileSync(join(root, ".github/workflows", workflow), "utf8"),
				workflow,
			).not.toMatch(/^\s+NODE_OPTIONS:/mu);
	});

	it("keeps every single-worker Vitest pin at one under the CI environment", async () => {
		const root = fileURLToPath(new URL("../..", import.meta.url));
		const configs = globSync("**/vitest*.config.ts", {
			cwd: root,
			exclude: ["**/node_modules/**", "**/dist/**", "external/**"],
		});
		const pinned: string[] = [];
		const previousMemoryCap = process.env.HOBO_TEST_MAX_WORKERS;
		const previousVitestCap = process.env.VITEST_MAX_WORKERS;
		process.env.HOBO_TEST_MAX_WORKERS = "8";
		process.env.VITEST_MAX_WORKERS = "8";
		try {
			for (const config of configs) {
				const source = readFileSync(join(root, config), "utf8");
				if (
					!/maxWorkers:\s*(?:1|capVitestWorkers\(1\))/u.test(source) &&
					!/fileParallelism:\s*false/u.test(source)
				)
					continue;
				pinned.push(config);
				expect(source, config).toContain("capVitestWorkers(1");
				const loaded: { default: { test?: { maxWorkers?: number } } } =
					await import(pathToFileURL(join(root, config)).href);
				expect(loaded.default.test?.maxWorkers, config).toBe(1);
			}
		} finally {
			if (previousMemoryCap === undefined)
				delete process.env.HOBO_TEST_MAX_WORKERS;
			else process.env.HOBO_TEST_MAX_WORKERS = previousMemoryCap;
			if (previousVitestCap === undefined)
				delete process.env.VITEST_MAX_WORKERS;
			else process.env.VITEST_MAX_WORKERS = previousVitestCap;
		}
		expect(pinned).toEqual(
			expect.arrayContaining([
				"packages/adapters/adapter-opensesame/vitest.real.config.ts",
				"packages/cli/vitest.config.ts",
				"packages/hobo/vitest.ci-e2e.config.ts",
				"src/draft/technical-proofs/hobo-componentize/vitest.config.ts",
			]),
		);
		for (const path of [
			".github/workflows/hobo-ci.yml",
			".github/workflows/pricing-ci.yml",
			"scripts/ci/memory-env.mts",
			"scripts/run-tests.ts",
		])
			expect(readFileSync(join(root, path), "utf8"), path).not.toMatch(
				/VITEST_MAX_WORKERS\s*[:=]/u,
			);
	});

	for (const expected of [
		{
			limitMb: 3072,
			cpuCount: 8,
			heapMb: 1152,
			turboConcurrency: 1,
			vitestMaxWorkers: 1,
		},
		{
			limitMb: 4096,
			cpuCount: 8,
			heapMb: 1664,
			turboConcurrency: 1,
			vitestMaxWorkers: 1,
		},
		{
			limitMb: 6144,
			cpuCount: 8,
			heapMb: 1344,
			turboConcurrency: 1,
			vitestMaxWorkers: 3,
		},
		{
			limitMb: 16_384,
			cpuCount: 4,
			heapMb: 3072,
			turboConcurrency: 1,
			vitestMaxWorkers: 4,
		},
	])
		it(`sizes a ${expected.limitMb} MiB job on ${expected.cpuCount} CPUs`, () => {
			const config = computeJobMemoryConfig(expected);
			expect(config).toEqual({
				heapMb: expected.heapMb,
				turboConcurrency: expected.turboConcurrency,
				vitestMaxWorkers: expected.vitestMaxWorkers,
			});
			expect(
				(config.vitestMaxWorkers + 1) * config.heapMb + 768,
			).toBeLessThanOrEqual(expected.limitMb);
		});

	it("keeps parent and worker heaps within every limit from 2048 through 16384", () => {
		for (let limitMb = 2048; limitMb <= 16_384; limitMb += 1) {
			const config = computeJobMemoryConfig({ limitMb, cpuCount: 8 });
			expect(
				config.vitestMaxWorkers,
				`limitMb=${limitMb}`,
			).toBeGreaterThanOrEqual(1);
			expect(
				(config.vitestMaxWorkers + 1) * config.heapMb + 768,
				`limitMb=${limitMb}`,
			).toBeLessThanOrEqual(limitMb);
		}
	});

	it("appends resolved values to GITHUB_ENV without installed dependencies", () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-memory-env-"));
		temporaryDirectories.push(directory);
		const githubEnv = join(directory, "github-env");
		writeFileSync(githubEnv, "EXISTING=value\n");
		let cgroupMemoryMaxMb: number | undefined;
		try {
			const value = readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
			if (/^\d+$/u.test(value))
				cgroupMemoryMaxMb = Math.floor(Number(value) / 1024 / 1024);
		} catch {
			cgroupMemoryMaxMb = undefined;
		}
		const host = {
			cgroupMemoryMaxMb,
			totalMemMb: Math.floor(totalmem() / 1024 / 1024),
		};
		const limitMb = resolveJobMemoryLimitMb({}, host);
		const config = computeJobMemoryConfig({
			limitMb,
			cpuCount: availableParallelism(),
		});
		const script = fileURLToPath(
			new URL("../ci/memory-env.mts", import.meta.url),
		);
		const result = spawnSync(
			process.execPath,
			["--experimental-strip-types", script],
			{
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", GITHUB_ENV: githubEnv },
			},
		);
		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(githubEnv, "utf8")).toBe(
			`EXISTING=value\n${jobMemoryEnvLines(config).join("\n")}\n`,
		);
	});
});
