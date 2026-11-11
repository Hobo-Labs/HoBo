import { describe, expect, it } from "vitest";
import {
	depsHeadroomCandidatePaths,
	pickDepsHeadroomSamplePath,
} from "../src/isolated-worker/deps-docker-headroom.js";

describe("deps docker headroom path picking", () => {
	it("orders host job directory before workspace and root", () => {
		expect(
			depsHeadroomCandidatePaths({
				hostJobDirectory: "/opt/actions-runner/_hobo_work/job1",
				githubWorkspace: "/work/HoBo",
				pnpmStoreExists: true,
			}),
		).toEqual([
			"/opt/actions-runner/_hobo_work/job1",
			"/work/HoBo",
			"/pnpm-store",
			"/",
		]);
	});

	it("prefers a device-matched bind mount over a fallback", () => {
		const pick = pickDepsHeadroomSamplePath({
			dockerRootDir: "/var/lib/docker",
			dockerRootMounted: false,
			dockerRootDevice: "259",
			candidates: ["/work/HoBo", "/"],
			candidateDevice: (path) => (path === "/work/HoBo" ? "259" : "1"),
			canSample: () => true,
		});
		expect(pick).toEqual({
			path: "/work/HoBo",
			strategy: "device-matched",
		});
	});

	it("falls back to another bind mount when device matching fails", () => {
		const pick = pickDepsHeadroomSamplePath({
			dockerRootDir: "/var/lib/docker",
			dockerRootMounted: false,
			dockerRootDevice: "259",
			candidates: ["/work/HoBo", "/"],
			candidateDevice: () => "1",
			canSample: (path) => path === "/",
		});
		expect(pick).toEqual({
			path: "/",
			strategy: "bind-mount-fallback",
		});
	});

	it("uses host docker root sampling when bind mounts are not sampleable", () => {
		const pick = pickDepsHeadroomSamplePath({
			dockerRootDir: "/var/lib/docker",
			dockerRootMounted: false,
			dockerRootDevice: "259",
			candidates: ["/work/HoBo"],
			candidateDevice: () => undefined,
			canSample: () => false,
			canSampleHostDockerRoot: (root) => root === "/var/lib/docker",
		});
		expect(pick).toEqual({
			path: "host:/var/lib/docker",
			strategy: "host-docker-root",
		});
	});
});
