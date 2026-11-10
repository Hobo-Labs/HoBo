import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	moveExtractedPackageDir,
	RELEASE_OCI_STAGE_SPECS,
	releaseOciAffectedImageIds,
	releaseOciDeployArgs,
	releaseOciDockerignore,
	releaseOciStagingLocation,
	releaseOciTurboBuildArgs,
	releasePnpmStore,
	resolveReleaseTurboBase,
	sdkOverlayExtractRoot,
	stageReleaseOciApp,
} from "../ci/stage-release-oci-app.mts";
import { SDK_PACKAGES } from "../ci/stage-sdk-artifacts.mts";
import { loadReleaseOciManifest } from "../lib/release-oci-contract.mts";

const root = join(import.meta.dirname, "..", "..");

function runQuiet(cwd: string, command: string, args: readonly string[]): void {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	expect(
		result.status,
		`${result.stdout}\n${result.stderr}\n${result.error?.message ?? ""}`,
	).toBe(0);
}

describe("release OCI app staging", () => {
	it("resolves the Turbo base on a sparse PR checkout", () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-release-turbo-base-"));
		const git = (...args: string[]): void => {
			const result = spawnSync("git", args, { cwd: repo, stdio: "ignore" });
			expect(result.status).toBe(0);
		};
		try {
			git("init", "--quiet");
			for (const message of ["base", "merge"]) {
				git(
					"-c",
					"user.name=Release Test",
					"-c",
					"user.email=release@example.com",
					"-c",
					"commit.gpgsign=false",
					"commit",
					"--allow-empty",
					"-m",
					message,
				);
			}
			expect(resolveReleaseTurboBase(repo, "origin/main")).toBe("HEAD^1");
			expect(resolveReleaseTurboBase(repo, "HEAD")).toBe("HEAD");
			expect(() => resolveReleaseTurboBase(repo, "refs/heads/missing")).toThrow(
				/HOBO_RELEASE_TURBO_BASE=refs\/heads\/missing does not resolve/,
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("builds the full importer closure on tag release when origin/main is absent", () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-release-turbo-tag-"));
		const previousRef = process.env.GITHUB_REF;
		const previousEvent = process.env.GITHUB_EVENT_NAME;
		const git = (...args: string[]): void => {
			const result = spawnSync("git", args, { cwd: repo, stdio: "ignore" });
			expect(result.status).toBe(0);
		};
		try {
			git("init", "--quiet");
			git(
				"-c",
				"user.name=Release Test",
				"-c",
				"user.email=release@example.com",
				"-c",
				"commit.gpgsign=false",
				"commit",
				"--allow-empty",
				"-m",
				"tag",
			);
			process.env.GITHUB_REF = "refs/tags/v0.0.0-alpha.0";
			delete process.env.GITHUB_EVENT_NAME;
			expect(resolveReleaseTurboBase(repo, "origin/main")).toBeUndefined();
			process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
			expect(resolveReleaseTurboBase(repo, "origin/main")).toBeUndefined();
		} finally {
			if (previousRef === undefined) delete process.env.GITHUB_REF;
			else process.env.GITHUB_REF = previousRef;
			if (previousEvent === undefined) delete process.env.GITHUB_EVENT_NAME;
			else process.env.GITHUB_EVENT_NAME = previousEvent;
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("combines SCM-affected and requested image filters", () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-release-turbo-filters-"));
		const previousBase = process.env.HOBO_RELEASE_TURBO_BASE;
		const git = (...args: string[]): void => {
			const result = spawnSync("git", args, { cwd: repo, stdio: "ignore" });
			expect(result.status).toBe(0);
		};
		try {
			git("init", "--quiet");
			for (const message of ["base", "head"]) {
				git(
					"-c",
					"user.name=Release Test",
					"-c",
					"user.email=release@example.com",
					"-c",
					"commit.gpgsign=false",
					"commit",
					"--allow-empty",
					"-m",
					message,
				);
			}
			process.env.HOBO_RELEASE_TURBO_BASE = "HEAD^1";
			expect(
				releaseOciTurboBuildArgs(repo, [
					"@hobo/hobo...",
					"@hobo/ci-gh-actions...",
				]),
			).toEqual([
				"exec",
				"turbo",
				"run",
				"build",
				"--filter=...[HEAD^1...HEAD]",
				"--filter=@hobo/hobo...",
				"--filter=@hobo/ci-gh-actions...",
			]);
			delete process.env.HOBO_RELEASE_TURBO_BASE;
			expect(releaseOciTurboBuildArgs(repo, ["hobo-site..."])).toEqual([
				"exec",
				"turbo",
				"run",
				"build",
				"--filter=hobo-site...",
			]);
		} finally {
			if (previousBase === undefined) {
				delete process.env.HOBO_RELEASE_TURBO_BASE;
			} else {
				process.env.HOBO_RELEASE_TURBO_BASE = previousBase;
			}
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("covers exactly the image ids in the release manifest", () => {
		const manifest = loadReleaseOciManifest(root);
		expect(Object.keys(RELEASE_OCI_STAGE_SPECS).sort()).toEqual(
			manifest.images.map((image) => image.id).sort(),
		);
	});

	it.each([
		["hobo-cli", "@hobo/hobo", "@hobo/hobo..."],
		["hobo-code", "@hobo/code", "@hobo/code..."],
		["hobo-codegen", "@hobo/schema-tools", "@hobo/schema-tools..."],
		["hobo-ci-serve", "@hobo/ci-gh-actions", "@hobo/ci-gh-actions..."],
	])("stages %s as a deployed app", (imageId, packageName, buildFilter) => {
		expect(
			Object.entries(RELEASE_OCI_STAGE_SPECS).find(
				([id]) => id === imageId,
			)?.[1],
		).toMatchObject({
			kind: "deploy",
			packageName,
			buildFilter,
			appPath: "app",
		});
	});

	it("limits every deploy to the build host architecture", () => {
		const storeDir = resolve("test-store/v10");
		const specs = Object.values(RELEASE_OCI_STAGE_SPECS).filter(
			(spec) => spec.kind === "deploy",
		);
		expect(specs).toHaveLength(4);
		for (const spec of specs) {
			const appDir = join("staging", spec.appPath);
			expect(releaseOciDeployArgs(spec.packageName, appDir, storeDir)).toEqual([
				"--filter",
				spec.packageName,
				"deploy",
				"--prod",
				"--prefer-offline",
				"--config.inject-workspace-packages=true",
				"--cpu=current",
				"--os=current",
				"--libc=current",
				"--store-dir",
				storeDir,
				appDir,
			]);
		}
	});

	it("stages on a same-device store with hardlinks", () => {
		const storeDir = resolve("test-store");
		const options = {
			root,
			env: {
				npm_config_store_dir: storeDir,
				GITHUB_RUN_ID: "123",
				GITHUB_JOB: "release",
				GITHUB_RUN_ATTEMPT: "2",
			},
			stat: () => ({ dev: 1 }),
			mkdir: () => undefined,
		};
		const location = releaseOciStagingLocation("hobo-cli", options);
		expect(location).toEqual({
			stagingRoot: join(
				storeDir,
				".hobo-release-staging/hobo-cli/123-release-2",
			),
			hardlink: true,
			storeDir,
		});
		expect(releaseOciStagingLocation("hobo-cli", options)).toEqual(location);
		expect(
			releaseOciDeployArgs("@hobo/hobo", "app", storeDir, location.hardlink),
		).toContain("--config.package-import-method=hardlink");
	});

	it("pins the workspace store for a deployment on another filesystem", () => {
		const storeDir = releasePnpmStore(root);
		const target = mkdtempSync(join(tmpdir(), "hobo-release-store-"));
		try {
			const result = spawnSync("pnpm", ["store", "path", "--silent"], {
				cwd: target,
				encoding: "utf8",
				env: { ...process.env, npm_config_store_dir: storeDir },
			});
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe(storeDir);
			expect(releaseOciDeployArgs("@hobo/hobo", target, storeDir)).toContain(
				storeDir,
			);
			expect(() =>
				releaseOciDeployArgs("@hobo/hobo", target, "relative"),
			).toThrow();
		} finally {
			rmSync(target, { recursive: true, force: true });
		}
	});

	it("keeps in-repo staging and default imports without a store", () => {
		expect(releaseOciStagingLocation("hobo-cli", { root, env: {} })).toEqual({
			stagingRoot: join(root, "deploy/release-images/.staging/hobo-cli"),
			hardlink: false,
		});
	});

	it("keeps in-repo staging when the store is on another device", () => {
		const storeDir = resolve("test-store");
		expect(
			releaseOciStagingLocation("hobo-cli", {
				root,
				env: { npm_config_store_dir: storeDir },
				stat: (path) => ({ dev: path === storeDir ? 1 : 2 }),
				mkdir: () => undefined,
			}),
		).toEqual({
			stagingRoot: join(root, "deploy/release-images/.staging/hobo-cli"),
			hardlink: false,
		});
	});

	it("stages executable wrappers for package entrypoints", () => {
		expect(RELEASE_OCI_STAGE_SPECS["hobo-cli"]).toMatchObject({
			wrappers: [
				{ name: "hobo", entrypoint: "dist/bin/hobo.js" },
				{ name: "hobo-mcp", entrypoint: "dist/bin/hobo-mcp.js" },
			],
		});
		expect(RELEASE_OCI_STAGE_SPECS["hobo-code"]).toMatchObject({
			wrappers: [{ name: "hobo-code", entrypoint: "dist/bin/hobo-code.js" }],
		});
		expect(RELEASE_OCI_STAGE_SPECS["hobo-codegen"]).toMatchObject({
			wrappers: [{ name: "hobo-codegen", entrypoint: "dist/cli.js" }],
		});
	});

	it("stages SDK tarballs, site output, and the MCP dependency marker", () => {
		expect(RELEASE_OCI_STAGE_SPECS["hobo-sdk"]).toEqual({
			kind: "sdk",
			artifactsPath: "artifacts",
		});
		expect(RELEASE_OCI_STAGE_SPECS["hobo-site"]).toEqual({
			kind: "site",
			distPath: "dist",
			serverPath: "server.mjs",
		});
		expect(RELEASE_OCI_STAGE_SPECS["hobo-mcp"]).toEqual({
			kind: "mcp",
			markerPath: ".hobo-cli-candidate",
		});
	});

	it("refuses to stage an image outside the affected allowlist", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "hobo-release-affected-"));
		try {
			expect(releaseOciAffectedImageIds({})).toBeUndefined();
			expect(
				releaseOciAffectedImageIds({
					HOBO_RELEASE_OCI_AFFECTED_IMAGE_IDS: " hobo-cli  hobo-mcp ",
				}),
			).toEqual(["hobo-cli", "hobo-mcp"]);
			expect(() =>
				stageReleaseOciApp("hobo-site", join(fixtureRoot, "blocked"), {
					root,
					skipBuild: true,
					env: { HOBO_RELEASE_OCI_AFFECTED_IMAGE_IDS: "hobo-cli hobo-mcp" },
				}),
			).toThrow(
				/release image hobo-site is not in HOBO_RELEASE_OCI_AFFECTED_IMAGE_IDS/,
			);
			stageReleaseOciApp("hobo-mcp", join(fixtureRoot, "allowed"), {
				root,
				env: { HOBO_RELEASE_OCI_AFFECTED_IMAGE_IDS: "hobo-cli hobo-mcp" },
			});
			expect(
				readFileSync(join(fixtureRoot, "allowed/.hobo-cli-candidate"), "utf8"),
			).toBe("hobo-cli:candidate\n");
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("fails clearly when the site build output is missing", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "hobo-release-site-"));
		try {
			expect(() =>
				stageReleaseOciApp("hobo-site", join(fixtureRoot, "staging"), {
					root: join(fixtureRoot, "checkout"),
					skipBuild: true,
				}),
			).toThrow(/site build output missing: .*site\/dist/);
		} finally {
			rmSync(fixtureRoot, { recursive: true, force: true });
		}
	});

	it("allowlists only staged artifacts in each docker context", () => {
		expect(releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-cli"])).toBe(
			"*\n!.dockerignore\n!app/\n!app/**\n!app/bin/\n!app/bin/**\n",
		);
		expect(releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-sdk"])).toBe(
			"*\n!.dockerignore\n!artifacts/\n!artifacts/**\n",
		);
		expect(releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-site"])).toBe(
			"*\n!.dockerignore\n!dist/\n!dist/**\n!server.mjs\n",
		);
		expect(releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-mcp"])).toBe(
			"*\n!.dockerignore\n!.hobo-cli-candidate\n",
		);
	});

	it("writes .dockerignore into the staged context", () => {
		const stagingRoot = mkdtempSync(join(tmpdir(), "hobo-release-stage-"));
		try {
			stageReleaseOciApp("hobo-mcp", stagingRoot, { root });
			expect(readFileSync(join(stagingRoot, ".dockerignore"), "utf8")).toBe(
				releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-mcp"]),
			);
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	});

	it("builds every allowlisted SDK package", () => {
		expect(SDK_PACKAGES).toEqual([
			"@hobo/core",
			"@hobo/policy",
			"@hobo/bindles",
			"@hobo/contracts",
			"@hobo/contract-harness",
			"@hobo/runtime",
			"@hobo/runtime-local",
			"@hobo/storage-sqlite",
			"@hobo/wit",
			"@hobo/cli",
		]);
	});

	it("uses an overlay temp dir under the deploy app (same device as node_modules)", () => {
		const appDir = mkdtempSync(join(tmpdir(), "hobo-overlay-root-"));
		try {
			mkdirSync(appDir, { recursive: true });
			const extractRoot = sdkOverlayExtractRoot(appDir);
			expect(extractRoot.startsWith(appDir)).toBe(true);
			expect(extractRoot).toContain(".sdk-overlay-");
		} finally {
			rmSync(appDir, { recursive: true, force: true });
		}
	});

	it("copies extracted package dir when rename hits EXDEV", () => {
		const rootDir = mkdtempSync(join(tmpdir(), "hobo-exdev-move-"));
		const pkgDir = join(rootDir, "src", "package");
		const target = join(rootDir, "dest", "@hobo-labs", "core");
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(join(pkgDir, "package.json"), '{"name":"@hobo-labs/core"}');
		const calls: string[] = [];
		moveExtractedPackageDir(pkgDir, target, {
			renameSync: () => {
				throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
			},
			cpSync: (from, to) => {
				calls.push(`cp:${from}->${to}`);
			},
			rmSync: (path, opts) => {
				calls.push(`rm:${path}:${JSON.stringify(opts)}`);
			},
		});
		expect(calls).toEqual([
			`rm:${target}:{"recursive":true,"force":true}`,
			`cp:${pkgDir}->${target}`,
			`rm:${pkgDir}:{"recursive":true,"force":true}`,
		]);
		rmSync(rootDir, { recursive: true, force: true });
	});
});
