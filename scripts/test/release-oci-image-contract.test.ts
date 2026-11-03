import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadNpmScopeMap, mapPackageName } from "../ci/npm-publish-scope.mts";
import {
	type DockerInspectConfig,
	evaluateImageConfig,
	expectedConfig,
	loadReleaseOciManifest,
} from "../lib/release-oci-contract.mts";

const root = join(import.meta.dirname, "..", "..");

describe("release npm scope map", () => {
	it("maps @hobo/core to @hobo-labs/core", () => {
		const map = loadNpmScopeMap();
		expect(map.publicScope).toBe("@hobo-labs");
		expect(mapPackageName("@hobo/core", map)).toBe("@hobo-labs/core");
	});

	it("lists every mapped package under release/", () => {
		expect(existsSync(join(root, "release/npm-scope-map.json"))).toBe(true);
	});
});

describe("release OCI image contract (manifest)", () => {
	const manifest = loadReleaseOciManifest(root);

	it("declares GHCR repository prefix under hobo-labs", () => {
		expect(manifest.repositoryPrefix).toBe("ghcr.io/hobo-labs/hobo");
		expect(manifest.images.length).toBeGreaterThanOrEqual(5);
	});

	for (const image of manifest.images) {
		it(`${image.id} declares dockerfile and non-root user`, () => {
			expect(existsSync(join(root, image.dockerfile))).toBe(true);
			expect(image.user).toMatch(/^1000:1000$/);
			expect(image.entrypoint.length).toBeGreaterThan(0);
		});

		it(`${image.id} has a runtime-only Dockerfile`, () => {
			const dockerfile = readFileSync(join(root, image.dockerfile), "utf8");
			expect(dockerfile).not.toMatch(/pnpm\s+install|turbo\s+run|AS build/);
		});
	}

	it("server images declare health checks and ports", () => {
		const servers = manifest.images.filter((i) => i.expose?.length);
		for (const image of servers) {
			expect(image.healthcheckPath, image.id).toBeTruthy();
			expect(image.healthcheckPort, image.id).toBeTruthy();
		}
	});
});

function dockerInspectConfig(tag: string): DockerInspectConfig {
	const result = spawnSync(
		"docker",
		["inspect", "--format", "{{json .Config}}", tag],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		throw new Error(result.stderr || "docker inspect failed");
	}
	const raw: unknown = JSON.parse(result.stdout);
	// SAFETY: docker emits the `.Config` object shape documented for `docker inspect`.
	return raw as DockerInspectConfig;
}

function dockerRunVersion(tag: string, probe: string[]) {
	const result = spawnSync(
		"docker",
		["run", "--rm", "--entrypoint", "", tag, ...probe],
		{ encoding: "utf8" },
	);
	return {
		ok: result.status === 0,
		out: `${result.stdout}${result.stderr}`,
	} as const;
}

describe("release OCI image contract (live docker)", () => {
	const live = process.env.HOBO_RELEASE_OCI_CONTRACT === "live";
	const manifest = loadReleaseOciManifest(root);
	const requestedIds = process.env.HOBO_RELEASE_OCI_IMAGE_ID?.split(",")
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
	const liveIds = requestedIds?.length
		? requestedIds
		: manifest.images.map((image) => image.id);
	const version = process.env.HOBO_RELEASE_VERSION ?? "0.1.0-test";
	const revision = process.env.HOBO_RELEASE_REVISION ?? "deadbeef";

	for (const image of manifest.images) {
		const selected = live && liveIds.includes(image.id);
		it.runIf(selected)(`${image.id} evaluates built image config`, () => {
			const expected = expectedConfig(manifest, image, revision, version);
			const config = dockerInspectConfig(`${image.name}:candidate`);
			const checks = evaluateImageConfig(expected, config);
			const failed = checks.filter((check) => !check.ok);
			expect(
				failed,
				failed.map((failure) => failure.detail).join("; "),
			).toEqual([]);
		});

		it.runIf(selected)(`${image.id} runs its version probe as non-root`, () => {
			if (!image.versionProbe?.length) return;
			const run = dockerRunVersion(
				`${image.name}:candidate`,
				image.versionProbe,
			);
			expect(run.ok, run.out).toBe(true);
		});
	}
});
