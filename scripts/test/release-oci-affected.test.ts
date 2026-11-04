import { createHash } from "node:crypto";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadReleaseOciManifest } from "../lib/release-oci-contract.mts";
import {
	affectedReleaseOciImages,
	clearReleaseOciGitTreeCache,
	gitTree,
	imageInputs,
	isBuildInput,
	releaseInputGitTree,
	type ImageInputs,
	type RepoTree,
} from "../ci/release-oci-affected.mts";

const root = join(import.meta.dirname, "..", "..");

const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    devDependencies:
      typescript:
        specifier: ^6
        version: 6.0.3

  external/ts-autocode/packages/grounding: {}

  packages/code:
    dependencies:
      '@hobo/core':
        specifier: workspace:*
        version: link:../core
      ink:
        specifier: ^6
        version: 6.0.0(react@19.0.0)

  packages/core:
    dependencies:
      ts-autocode-grounding:
        specifier: workspace:*
        version: link:../../external/ts-autocode/packages/grounding
      zod:
        specifier: ^4
        version: 4.4.3

  packages/hobo:
    dependencies:
      '@hobo/code':
        specifier: workspace:*
        version: link:../code

  site:
    dependencies:
      astro:
        specifier: ^5
        version: 5.0.0

  src/draft/technical-proofs/x:
    dependencies:
      left-pad:
        specifier: ^1
        version: 1.3.0

packages:

  astro@5.0.0:
    resolution: {integrity: sha512-astro}

  ink@6.0.0:
    resolution: {integrity: sha512-ink}

  left-pad@1.3.0:
    resolution: {integrity: sha512-leftpad}

  react@19.0.0:
    resolution: {integrity: sha512-react}

  typescript@6.0.3:
    resolution: {integrity: sha512-ts}

  zod@4.4.3:
    resolution: {integrity: sha512-zod}

snapshots:

  astro@5.0.0: {}

  ink@6.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0

  left-pad@1.3.0: {}

  react@19.0.0: {}

  typescript@6.0.3: {}

  zod@4.4.3: {}
`;

const TURBO = {
	tasks: {
		build: {
			dependsOn: ["^build"],
			inputs: ["$TURBO_DEFAULT$", "!**/*.md", "!test/**", "!**/*.test.ts"],
			outputs: ["dist/**"],
		},
		test: { dependsOn: ["build"], outputs: [] },
	},
};

const image = (id: string) => ({
	id,
	name: id,
	title: id,
	description: id,
	dockerfile: `deploy/release-images/${id}/Dockerfile`,
	workdir: "/",
	user: "1000:1000",
	entrypoint: [id],
	cmd: [],
});

const MANIFEST = {
	owner: "hobo-labs",
	repositoryPrefix: "ghcr.io/hobo-labs/hobo",
	toolchainImageEnv: "HOBO_RELEASE_TOOLCHAIN_IMAGE",
	defaultToolchainTag: "hobo-ci-worker:local",
	images: ["hobo-cli", "hobo-code", "hobo-mcp", "hobo-site"].map(image),
};

const PACKAGES = new Map<string, readonly string[]>([
	["hobo-cli", ["@hobo/hobo"]],
	["hobo-code", ["@hobo/code"]],
	["hobo-site", ["hobo-site"]],
]);

type Json =
	| string
	| number
	| boolean
	| null
	| readonly Json[]
	| { readonly [key: string]: Json };
type RootPackageJson = {
	scripts?: { readonly [name: string]: string };
	pnpm?: { overrides: { readonly [name: string]: string } };
};

const json = (value: Json) => `${JSON.stringify(value, null, 2)}\n`;
const pkg = (name: string) => json({ name });

const BASE = {
	"pnpm-lock.yaml": LOCKFILE,
	"package.json": json({
		scripts: { build: "turbo run build" },
		packageManager: "pnpm@10.33.4",
		pnpm: { overrides: {} },
	}),
	"turbo.json": json(TURBO),
	"release/oci-images.json": json(MANIFEST),
	"mise.lock": "node 24\n",
	"packages/ci-gh-actions/deploy/ci-runner/Dockerfile": "FROM debian\n",
	"packages/core/package.json": pkg("@hobo/core"),
	"packages/core/src/index.ts": "export {};\n",
	"packages/core/test/index.test.ts": "it();\n",
	"packages/core/README.md": "# core\n",
	"packages/code/package.json": pkg("@hobo/code"),
	"packages/code/src/index.ts": "export {};\n",
	"packages/code/test/index.test.ts": "it();\n",
	"packages/hobo/package.json": pkg("@hobo/hobo"),
	"packages/hobo/src/index.ts": "export {};\n",
	"site/package.json": pkg("hobo-site"),
	"site/src/index.astro": "<p/>\n",
	"src/draft/technical-proofs/x/package.json": pkg("x"),
	"examples/try-site/yards.json": "{}\n",
	"deploy/release-images/hobo-cli/Dockerfile": "FROM toolchain\n",
	"deploy/release-images/hobo-code/Dockerfile": "FROM toolchain\n",
	"deploy/release-images/hobo-mcp/Dockerfile": "FROM hobo-cli\n",
	"deploy/release-images/hobo-site/Dockerfile": "FROM toolchain\n",
	"docs/release/pipelines.md": "# pipelines\n",
} satisfies Files;

type Files = { readonly [path: string]: string };

const GITLINKS = { "external/ts-autocode": "a".repeat(40) };

function tree(files: Files, gitlinks: Files = GITLINKS): RepoTree {
	const contents = new Map(Object.entries(files));
	return {
		files: new Map(
			[...contents].map(([path, text]) => [
				path,
				createHash("sha1").update(text).digest("hex"),
			]),
		),
		gitlinks: new Map(Object.entries(gitlinks)),
		read: (paths) =>
			new Map(
				paths.flatMap((path) => {
					const text = contents.get(path);
					return text === undefined ? [] : [[path, text] as const];
				}),
			),
	};
}

const packagesOf = (id: string) => PACKAGES.get(id) ?? [];

function affected(
	changes: Files,
	gitlinks?: Files,
	base: Files = BASE,
): string[] {
	return affectedReleaseOciImages(
		imageInputs(tree(base), packagesOf),
		imageInputs(tree({ ...base, ...changes }, gitlinks), packagesOf),
	).map(({ id }) => id);
}

const ALL = ["hobo-code", "hobo-cli", "hobo-mcp", "hobo-site"];

/** One scoped git ls-tree + imageInputs; ~1–15s on CI (was 30s+ full-tree ls-tree). */
const REPO_MANIFEST_INTEGRATION_TIMEOUT_MS = 60_000;

let repoHeadImageInputs: ReadonlyMap<string, ImageInputs> | undefined;

describe("affected release OCI images", () => {
	beforeAll(() => {
		clearReleaseOciGitTreeCache();
		repoHeadImageInputs = imageInputs(releaseInputGitTree("HEAD", root));
	}, REPO_MANIFEST_INTEGRATION_TIMEOUT_MS);
	it("builds nothing for an unchanged tree or files no image reads", () => {
		expect(affected({})).toEqual([]);
		expect(affected({ "docs/release/pipelines.md": "# changed\n" })).toEqual(
			[],
		);
		expect(
			affected({ "scripts/ci/release-oci-affected.mts": "// detector\n" }),
		).toEqual([]);
	});

	it("follows the lockfile closure, including runtime dependents", () => {
		expect(
			affected({ "packages/code/src/index.ts": "export const a = 1;\n" }),
		).toEqual(["hobo-code", "hobo-cli", "hobo-mcp"]);
		expect(
			affected({ "packages/hobo/src/index.ts": "export const a = 1;\n" }),
		).toEqual(["hobo-cli", "hobo-mcp"]);
		expect(affected({ "site/src/index.astro": "<p>x</p>\n" })).toEqual([
			"hobo-site",
		]);
	});

	it("ignores package files that are not Turbo build inputs", () => {
		expect(
			affected({ "packages/core/test/index.test.ts": "it(1);\n" }),
		).toEqual([]);
		expect(affected({ "packages/core/README.md": "# changed\n" })).toEqual([]);
	});

	it("uses a package's own build task inputs when turbo.json overrides them", () => {
		const base = {
			...BASE,
			"turbo.json": json({
				tasks: { ...TURBO.tasks, "@hobo/code#build": { outputs: ["dist/**"] } },
			}),
		};
		expect(
			affected(
				{ "packages/code/test/index.test.ts": "it(1);\n" },
				undefined,
				base,
			),
		).toEqual(["hobo-code", "hobo-cli", "hobo-mcp"]);
	});

	it("keys pnpm-lock.yaml by the slice each image's closure resolves", () => {
		const transitive = LOCKFILE.replace("sha512-react", "sha512-react2");
		expect(affected({ "pnpm-lock.yaml": transitive })).toEqual([
			"hobo-code",
			"hobo-cli",
			"hobo-mcp",
		]);
		const draftOnly = LOCKFILE.replace("sha512-leftpad", "sha512-leftpad2");
		expect(affected({ "pnpm-lock.yaml": draftOnly })).toEqual([]);
		const rootTool = LOCKFILE.replace("sha512-ts}", "sha512-ts2}");
		expect(affected({ "pnpm-lock.yaml": rootTool })).toEqual(ALL);
		const settings = LOCKFILE.replace(
			"autoInstallPeers: true",
			"autoInstallPeers: false",
		);
		expect(affected({ "pnpm-lock.yaml": settings })).toEqual(ALL);
	});

	it("follows a submodule package in the closure to its gitlink", () => {
		expect(affected({}, { "external/ts-autocode": "b".repeat(40) })).toEqual([
			"hobo-code",
			"hobo-cli",
			"hobo-mcp",
		]);
	});

	it("reads only the root package.json and turbo.json fields a build uses", () => {
		const rootPackage = (extra: RootPackageJson) =>
			json({
				scripts: { build: "turbo run build" },
				packageManager: "pnpm@10.33.4",
				pnpm: { overrides: {} },
				...extra,
			});
		expect(
			affected({
				"package.json": rootPackage({ scripts: { lint: "biome check ." } }),
			}),
		).toEqual([]);
		expect(
			affected({
				"package.json": rootPackage({ pnpm: { overrides: { zod: "4.4.4" } } }),
			}),
		).toEqual(ALL);
		expect(
			affected({
				"turbo.json": json({
					tasks: { ...TURBO.tasks, test: { dependsOn: [], outputs: [] } },
				}),
			}),
		).toEqual([]);
		expect(
			affected({
				"turbo.json": json({
					tasks: {
						...TURBO.tasks,
						build: { ...TURBO.tasks.build, outputs: ["lib/**"] },
					},
				}),
			}),
		).toEqual(ALL);
	});

	it.each([
		"mise.lock",
		"packages/ci-gh-actions/deploy/ci-runner/Dockerfile",
		"scripts/ci/build-release-oci-image.mts",
		"tsconfig.base.json",
	])("builds every image when the shared layer input %s changes", (path) => {
		expect(affected({ [path]: "changed\n" })).toEqual(ALL);
	});

	it("builds an image for its own Dockerfile and manifest entry, and its FROM dependents", () => {
		expect(
			affected({ "deploy/release-images/hobo-cli/Dockerfile": "FROM x\n" }),
		).toEqual(["hobo-cli", "hobo-mcp"]);
		expect(
			affected({ "deploy/release-images/hobo-mcp/Dockerfile": "FROM x\n" }),
		).toEqual(["hobo-mcp"]);
		const manifest = {
			...MANIFEST,
			images: MANIFEST.images.map((entry) =>
				entry.id === "hobo-site" ? { ...entry, cmd: ["serve"] } : entry,
			),
		};
		expect(affected({ "release/oci-images.json": json(manifest) })).toEqual([
			"hobo-site",
		]);
		expect(
			affected({
				"release/oci-images.json": json({ ...MANIFEST, owner: "x" }),
			}),
		).toEqual(ALL);
	});

	it("builds the site for the example inputs it reads by path", () => {
		expect(affected({ "examples/try-site/yards.json": "[]\n" })).toEqual([
			"hobo-site",
		]);
	});

	it("treats an image the base does not have as new", () => {
		const base = {
			...BASE,
			"release/oci-images.json": json({
				...MANIFEST,
				images: MANIFEST.images.filter((entry) => entry.id !== "hobo-site"),
			}),
		};
		expect(
			affected({ "release/oci-images.json": json(MANIFEST) }, undefined, base),
		).toEqual(["hobo-site"]);
	});

	it("fails closed when an image's package is not a lockfile importer", () => {
		expect(() =>
			imageInputs(tree(BASE), (id) =>
				id === "hobo-cli" ? ["@hobo/missing"] : [],
			),
		).toThrow(/@hobo\/missing is not a pnpm-lock.yaml importer/);
	});

	it("matches Turbo input globs relative to the package", () => {
		const inputs = [
			"$TURBO_DEFAULT$",
			"!**/*.md",
			"!test/**",
			"!vitest.*.config.*",
		];
		expect(isBuildInput("src/index.ts", inputs)).toBe(true);
		expect(isBuildInput("README.md", inputs)).toBe(false);
		expect(isBuildInput("src/deep/notes.md", inputs)).toBe(false);
		expect(isBuildInput("test/a/b.ts", inputs)).toBe(false);
		expect(isBuildInput("src/test/b.ts", inputs)).toBe(true);
		expect(isBuildInput("vitest.unit.config.ts", inputs)).toBe(false);
		expect(isBuildInput("anything", undefined)).toBe(true);
		expect(isBuildInput("src/a.ts", ["src/**"])).toBe(true);
		expect(isBuildInput("lib/a.ts", ["src/**"])).toBe(false);
	});

	it(
		"resolves every image of the repository's own manifest",
		() => {
			const head = repoHeadImageInputs;
			if (!head) throw new Error("beforeAll did not resolve repo HEAD inputs");
			const manifest = loadReleaseOciManifest(root);
			expect([...head.keys()].sort()).toEqual(
				manifest.images.map(({ id }) => id).sort(),
			);
			expect(affectedReleaseOciImages(head, head)).toEqual([]);
		},
		REPO_MANIFEST_INTEGRATION_TIMEOUT_MS,
	);
});
