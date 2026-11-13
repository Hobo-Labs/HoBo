import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DepsBuildTelemetrySchema } from "../../packages/ci-gh-actions/src/isolated-worker/deps-build-budget.js";
import { depsBuildDockerReserve } from "../../packages/ci-gh-actions/src/isolated-worker/deps-build-docker-reserve.js";
import { parseDepsBuildTelemetry } from "../lib/deps-build-headroom.mts";

describe("deps build headroom defaults", () => {
	it("does not import zod-backed deps-build-budget", () => {
		const source = readFileSync(
			join(process.cwd(), "scripts/ci/deps-build-headroom-defaults.mts"),
			"utf8",
		);
		expect(source).not.toMatch(/deps-build-budget/);
		expect(source).toMatch(/deps-build-docker-reserve/);
	});

	it("matches depsBuildDockerReserve for build-deps.sh", () => {
		const reserve = depsBuildDockerReserve();
		const root = process.cwd();
		const run = spawnSync(
			"node",
			[
				"--experimental-strip-types",
				"--no-warnings",
				"--import",
				join(root, "scripts/lib/ts-source-resolve.mts"),
				join(root, "scripts/ci/deps-build-headroom-defaults.mts"),
			],
			{ cwd: root, encoding: "utf8" },
		);
		expect(run.status).toBe(0);
		const [inodes, bytes] = run.stdout.trim().split(/\s+/u);
		expect(Number(inodes)).toBe(reserve.dockerDataRoot);
		expect(Number(bytes)).toBe(reserve.dockerDataRootBytes);
	});

	// The pre-install reader cannot load the worker's zod schema, so it has its
	// own; the two must decide the same way.
	it("reads telemetry the way the worker's schema does", () => {
		for (const text of [
			"{}",
			'{"peakDockerInodes":0}',
			'{"peakDockerInodes":180000,"peakDockerBytes":23622320128,"updatedAtMs":1}',
			"null",
			"[]",
			"7",
			'{"peakDockerInodes":-1}',
			'{"peakDockerBytes":1.5}',
			'{"updatedAtMs":"1"}',
			'{"peakDockerInodes":null}',
			'{"peakDockerInodes":1,"extra":true}',
		]) {
			const schema = DepsBuildTelemetrySchema.safeParse(JSON.parse(text));
			const own = parseDepsBuildTelemetry(text);
			expect(own !== undefined, text).toBe(schema.success);
			if (schema.success) expect(own, text).toEqual(schema.data);
		}
	});
});
