import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
	moveExtractedPackageDir,
	RELEASE_OCI_STAGE_SPECS,
	releaseOciAffectedImageIds,
	releaseOciDeployArgs,
	releaseOciDockerignore,
	releaseOciDockerignoreExcludes,
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

const WorkspaceManifest = z.object({
	name: z.string().optional(),
	files: z.array(z.string()).default([]),
});

// The three cases that take this do nothing but spawn git, some ten processes
// each against a fresh repository, and on a loaded runner those spawns alone
// have passed the 10 s default. No network is involved: the repositories have
// no remote.
const GIT_FIXTURE_TIMEOUT_MS = 30_000;

describe("release OCI app staging", () => {
	it("resolves the Turbo base on a sparse PR checkout", {
		timeout: GIT_FIXTURE_TIMEOUT_MS,
	}, () => {
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

	it("builds the full importer closure on tag release when origin/main is absent", {
		timeout: GIT_FIXTURE_TIMEOUT_MS,
	}, () => {
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

	it("combines SCM-affected and requested image filters", {
		timeout: GIT_FIXTURE_TIMEOUT_MS,
	}, () => {
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
		expect(specs).toHaveLength(3);
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

	it("prefers npm_config_store_dir without shelling out to pnpm", () => {
		const storeDir = resolve("/pnpm-store");
		expect(
			releasePnpmStore(root, {
				npm_config_store_dir: storeDir,
				PATH: "/usr/bin",
			}),
		).toBe(storeDir);
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
			[
				"*",
				"!.dockerignore",
				"!app/",
				"!app/**",
				"!app/bin/",
				"!app/bin/**",
				"app/**/*.map",
				"app/**/test/**",
				"app/**/__tests__/**",
				"app/**/*.md",
				"app/**/DESIGN.md",
				"",
			].join("\n"),
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

	it("reads a .dockerignore the way Docker does", () => {
		const rules = "*\n!keep/\n!keep/**\nkeep/**/*.log\n# note\n\n!keep/x.log\n";
		const excluded = (path: string) =>
			releaseOciDockerignoreExcludes(rules, path);
		expect(excluded("other/file")).toBe(true);
		expect(excluded("keep")).toBe(false);
		expect(excluded("keep/a/b/file.js")).toBe(false);
		expect(excluded("keep/a/b/run.log")).toBe(true);
		expect(excluded("keep/run.log")).toBe(true);
		// A later rule wins, and a rule on a directory covers what is in it.
		expect(excluded("keep/x.log")).toBe(false);
		expect(releaseOciDockerignoreExcludes("a/**/t/**\n", "a/b/t/c/d")).toBe(
			true,
		);
		expect(releaseOciDockerignoreExcludes("a/**/t/**\n", "a/t/c")).toBe(true);
		expect(releaseOciDockerignoreExcludes("a/**/t/**\n", "a/tt/c")).toBe(false);
		expect(releaseOciDockerignoreExcludes("a.b\n", "axb")).toBe(false);
	});

	it("keeps everything outside the staged artifacts out of each context", () => {
		for (const spec of Object.values(RELEASE_OCI_STAGE_SPECS)) {
			const rules = releaseOciDockerignore(spec);
			for (const stray of [
				"Dockerfile",
				"package.json",
				"node_modules/zod/index.js",
				".git/config",
				"packages/hobo/src/index.ts",
				"app-old/dist/index.js",
			])
				expect(
					releaseOciDockerignoreExcludes(rules, stray),
					`${spec.kind}: ${stray}`,
				).toBe(true);
			expect(releaseOciDockerignoreExcludes(rules, ".dockerignore")).toBe(
				false,
			);
		}
	});

	it("leaves every path a release Dockerfile copies in its context", () => {
		for (const [id, spec] of Object.entries(RELEASE_OCI_STAGE_SPECS)) {
			const rules = releaseOciDockerignore(spec);
			const dockerfile = readFileSync(
				join(root, "deploy/release-images", id, "Dockerfile"),
				"utf8",
			);
			const sources = dockerfile
				.split("\n")
				.filter((line) => /^COPY\s/u.test(line) && !/--from=/u.test(line))
				.flatMap((line) =>
					line
						.split(/\s+/u)
						.slice(1)
						.filter((word) => !word.startsWith("--"))
						.slice(0, -1),
				);
			if (spec.kind !== "mcp") expect(sources.length, id).toBeGreaterThan(0);
			for (const source of sources)
				expect(
					releaseOciDockerignoreExcludes(rules, source),
					`${id}: COPY ${source}`,
				).toBe(false);
			const staged: string[] = [];
			switch (spec.kind) {
				case "deploy":
					staged.push(
						"app/package.json",
						"app/dist/index.js",
						"app/dist/bin/hobo.js",
						"app/node_modules/zod/index.cjs",
						"app/node_modules/.pnpm/pg@8.0.0/node_modules/pg/lib/native/index.js",
						"app/node_modules/@hobo/wit/wit/world.wit",
						"app/node_modules/x/build/Release/addon.node",
						"app/node_modules/x/dist/module.wasm",
						...("wrappers" in spec ? spec.wrappers : []).flatMap((wrapper) => [
							`app/bin/${wrapper.name}`,
							`app/${wrapper.entrypoint}`,
						]),
					);
					break;
				case "sdk":
					staged.push(`${spec.artifactsPath}/hobo-labs-core-0.0.0.tgz`);
					break;
				case "site":
					staged.push(`${spec.distPath}/docs/index.html`, spec.serverPath);
					break;
				case "mcp":
					staged.push(spec.markerPath);
					break;
			}
			for (const path of staged)
				expect(
					releaseOciDockerignoreExcludes(rules, path),
					`${id}: ${path}`,
				).toBe(false);
		}
	});

	it("drops only build noise from a deploy context", () => {
		const rules = releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-cli"]);
		for (const noise of [
			"app/dist/index.js.map",
			"app/node_modules/zod/v4/index.d.cts.map",
			"app/node_modules/resolve/test/core.js",
			"app/node_modules/.pnpm/qs@6.0.0/node_modules/qs/test/parse.js",
			"app/node_modules/x/src/__tests__/a.js",
			"app/README.md",
			"app/node_modules/@hobo/core/README.md",
		])
			expect(releaseOciDockerignoreExcludes(rules, noise), noise).toBe(true);
	});

	it("keeps every data file a workspace package ships in a deploy context", () => {
		// `hobo` scaffolds from @hobo/patterns' starter trees at run time; a rule
		// on `*.test.*` once dropped their `app.test.ts.tpl` from the image.
		const rules = releaseOciDockerignore(RELEASE_OCI_STAGE_SPECS["hobo-cli"]);
		const walk = (path: string): string[] =>
			statSync(path).isDirectory()
				? readdirSync(path).flatMap((name) => walk(join(path, name)))
				: [path];
		let checked = 0;
		for (const directory of readdirSync(join(root, "packages"))) {
			const packageRoot = join(root, "packages", directory);
			const manifestPath = join(packageRoot, "package.json");
			if (!existsSync(manifestPath)) continue;
			const { name, files } = WorkspaceManifest.parse(
				JSON.parse(readFileSync(manifestPath, "utf8")),
			);
			if (!name) continue;
			for (const entry of files) {
				// Build output is covered above; docs are left out on purpose.
				if (entry === "dist" || !existsSync(join(packageRoot, entry))) continue;
				for (const file of walk(join(packageRoot, entry))) {
					if (file.endsWith(".md")) continue;
					const shipped = relative(packageRoot, file).replaceAll("\\", "/");
					for (const base of [
						`app/node_modules/${name}`,
						`app/node_modules/.pnpm/pkg@0.0.0/node_modules/${name}`,
					])
						expect(
							releaseOciDockerignoreExcludes(rules, `${base}/${shipped}`),
							`${name}: ${shipped}`,
						).toBe(false);
					checked++;
				}
			}
		}
		expect(
			releaseOciDockerignoreExcludes(
				rules,
				"app/node_modules/@hobo/patterns/patterns/starter/cli/api/project/app.test.ts.tpl",
			),
		).toBe(false);
		expect(
			existsSync(
				join(
					root,
					"packages/patterns/patterns/starter/cli/api/project/app.test.ts.tpl",
				),
			),
		).toBe(true);
		expect(checked).toBeGreaterThan(50);
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
