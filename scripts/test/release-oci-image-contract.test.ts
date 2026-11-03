import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

	it("maps @hobo/code to @hobo-labs/code", () => {
		expect(mapPackageName("@hobo/code")).toBe("@hobo-labs/code");
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
	}

	it("declares the independent hobo-code image contract", () => {
		const image = manifest.images.find(
			(candidate) => candidate.id === "hobo-code",
		);
		if (!image) throw new Error("hobo-code release image is missing");
		expect(`${manifest.repositoryPrefix}/${image.name}`).toBe(
			"ghcr.io/hobo-labs/hobo/hobo-code",
		);
		expect(image).toMatchObject({
			dockerfile: "deploy/release-images/hobo-code/Dockerfile",
			workdir: "/home/hobo",
			user: "1000:1000",
			entrypoint: ["hobo-code"],
			cmd: ["--help"],
			versionProbe: ["hobo-code", "--help"],
			volumes: ["/home/hobo/.hobo"],
		});
		expect(image.envDoc?.join("\n")).toContain("HOBO_HOME");
		expect(image.envDoc?.join("\n")).toContain(
			"HOBO_TENANT / HOBO_PROJECT / HOBO_BRANCH / HOBO_ENV",
		);
	});

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

function dockerRunVersion(probe: string[]) {
	const result = spawnSync(
		"docker",
		["run", "--rm", "hobo-cli:candidate", ...probe],
		{
			encoding: "utf8",
		},
	);
	return {
		ok: result.status === 0,
		out: `${result.stdout}${result.stderr}`,
	} as const;
}

describe("release OCI image contract (live docker)", () => {
	const live = process.env.HOBO_RELEASE_OCI_CONTRACT === "live";
	const manifest = loadReleaseOciManifest(root);

	it("evaluates built image config when HOBO_RELEASE_OCI_CONTRACT=live", () => {
		if (!live) return;
		const image = manifest.images.find((i) => i.id === "hobo-cli");
		expect(image).toBeDefined();
		if (!image) return;
		const expected = expectedConfig(manifest, image, "deadbeef", "0.1.0-test");
		const config = dockerInspectConfig("hobo-cli:candidate");
		const checks = evaluateImageConfig(expected, config);
		const failed = checks.filter((c) => !c.ok);
		expect(failed, failed.map((f) => f.detail).join("; ")).toEqual([]);
	});

	it("runs version probe as non-root when live", () => {
		if (!live) return;
		const image = manifest.images.find((i) => i.id === "hobo-cli");
		if (!image?.versionProbe?.length) return;
		const run = dockerRunVersion(image.versionProbe);
		expect(run.ok, run.out).toBe(true);
	});
});
