import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	busyJobContainers,
	identifySelfContainer,
	parseRunningContainers,
	type RunningContainer,
	windowDecision,
} from "../lib/deps-build-window.mts";

const OWN_NAME = "hobo-11111111-1111-4111-8111-111111111111";
const OTHER_NAME = "hobo-22222222-2222-4222-8222-222222222222";
const OWN_ID = `${"a".repeat(12)}${"0".repeat(52)}`;
const OTHER_ID = `${"b".repeat(12)}${"0".repeat(52)}`;

const own: RunningContainer = { id: OWN_ID, name: OWN_NAME };
const other: RunningContainer = { id: OTHER_ID, name: OTHER_NAME };
const registry: RunningContainer = {
	id: `${"c".repeat(12)}${"0".repeat(52)}`,
	name: "hobo-ci-registry",
};

describe("deps build window: which containers count as busy", () => {
	it("parses docker ps id and name columns", () => {
		expect(
			parseRunningContainers(
				`${OWN_ID}\t${OWN_NAME}\n${OTHER_ID}\t${OTHER_NAME}\n\n`,
			),
		).toEqual([own, other]);
	});

	it("knows its own container from the job directory the worker mounts", () => {
		// container-controller names the container and the job directory `hobo-<lease id>`.
		const self = identifySelfContainer({
			hostJobDirectory: `/var/lib/hobo-ci/work/${OWN_NAME}`,
			hostName: "unrelated",
			inContainer: true,
			containers: [own, other],
		});
		expect(self).toEqual({
			kind: "known",
			name: OWN_NAME,
			source: "host-job-directory",
		});
		expect(busyJobContainers([own, other, registry], self)).toEqual([
			OTHER_NAME,
		]);
	});

	it("knows its own container from the host name Docker gives it", () => {
		const self = identifySelfContainer({
			hostName: OWN_ID.slice(0, 12),
			inContainer: true,
			containers: [own, other],
		});
		expect(self).toEqual({
			kind: "known",
			name: OWN_NAME,
			source: "host-name",
		});
		expect(busyJobContainers([own, other], self)).toEqual([OTHER_NAME]);
	});

	it("does not wait on itself when it is the only job on the box", () => {
		const self = identifySelfContainer({
			hostJobDirectory: `/work/${OWN_NAME}`,
			inContainer: true,
			containers: [own, registry],
		});
		expect(busyJobContainers([own, registry], self)).toEqual([]);
		expect(
			windowDecision({
				busyJobContainers: 0,
				self,
				elapsedMs: 0,
				maxWaitMs: 900_000,
				unknownSelfMaxWaitMs: 120_000,
			}),
		).toBe("open");
	});

	it("counts every job container when the caller is not in one", () => {
		const self = identifySelfContainer({
			hostName: "box-1",
			inContainer: false,
			containers: [own, other],
		});
		expect(self).toEqual({ kind: "none" });
		expect(busyJobContainers([own, other, registry], self)).toEqual([
			OWN_NAME,
			OTHER_NAME,
		]);
	});

	it("ignores a job directory or host name that names no job container", () => {
		expect(
			identifySelfContainer({
				hostJobDirectory: "/work/not-a-job",
				hostName: "d".repeat(12),
				inContainer: true,
				containers: [own, other],
			}),
		).toEqual({ kind: "unknown" });
	});
});

describe("deps build window: decision", () => {
	const known = {
		kind: "known",
		name: OWN_NAME,
		source: "host-job-directory",
	} as const;
	const base = { maxWaitMs: 900_000, unknownSelfMaxWaitMs: 120_000 };

	it("waits on another job, then fails at the bound", () => {
		expect(
			windowDecision({
				...base,
				busyJobContainers: 1,
				self: known,
				elapsedMs: 10_000,
			}),
		).toBe("wait");
		expect(
			windowDecision({
				...base,
				busyJobContainers: 1,
				self: known,
				elapsedMs: 900_000,
			}),
		).toBe("fail");
	});

	it("proceeds after a short bound when it cannot tell which container is its own", () => {
		const input = {
			...base,
			busyJobContainers: 1,
			self: { kind: "unknown" },
		} as const;
		expect(windowDecision({ ...input, elapsedMs: 119_999 })).toBe("wait");
		expect(windowDecision({ ...input, elapsedMs: 120_000 })).toBe("proceed");
		expect(windowDecision({ ...input, elapsedMs: 900_000 })).toBe("proceed");
	});

	it("opens on an idle box however long it has waited: low headroom alone does not block", () => {
		// build-deps.sh enforces headroom after the window, pruning the builder
		// cache and old deps images first; waiting here would never prune.
		for (const self of [known, { kind: "unknown" }, { kind: "none" }] as const)
			for (const elapsedMs of [0, 900_000])
				expect(
					windowDecision({ ...base, busyJobContainers: 0, self, elapsedMs }),
				).toBe("open");
	});

	it("caps the unknown-caller bound at the overall bound", () => {
		expect(
			windowDecision({
				busyJobContainers: 1,
				self: { kind: "unknown" },
				elapsedMs: 5_000,
				maxWaitMs: 5_000,
				unknownSelfMaxWaitMs: 120_000,
			}),
		).toBe("proceed");
	});
});

describe("deps build window: wiring", () => {
	const root = join(import.meta.dirname, "..", "..");
	const read = (path: string) => readFileSync(join(root, path), "utf8");

	it("the wait script decides through the tested functions", () => {
		const script = read("scripts/ci/wait-deps-build-window.mts");
		for (const name of [
			"identifySelfContainer",
			"busyJobContainers",
			"windowDecision",
			"HOBO_CI_HOST_JOB_DIRECTORY",
		])
			expect(script).toContain(name);
	});

	it("the wait script leaves Docker headroom to build-deps.sh", () => {
		const script = read("scripts/ci/wait-deps-build-window.mts");
		expect(script).not.toContain("deps-build-headroom");
		expect(script).not.toContain("headroomOk");
		const build = read(
			"packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh",
		);
		const ensure = build.indexOf("ensure_deps_build_headroom() {");
		expect(build.indexOf("builder prune", ensure)).toBeGreaterThan(ensure);
		expect(build.indexOf("refusing deps rebuild", ensure)).toBeGreaterThan(
			build.indexOf("builder prune", ensure),
		);
	});

	it("the worker still gives a job the identity the script reads", () => {
		const controller = read(
			"packages/ci-gh-actions/src/isolated-worker/container-controller.ts",
		);
		// The container name and the mounted job directory share `hobo-<lease id>`.
		expect(controller).toContain(
			"env.HOBO_CI_HOST_JOB_DIRECTORY = jobDirectory",
		);
		expect(controller).toContain("join(options.workRoot, `hobo-${leaseId}`)");
		expect(controller).toContain("const name = `hobo-${id}`;");
	});
});
