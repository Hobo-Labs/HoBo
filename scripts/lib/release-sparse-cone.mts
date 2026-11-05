/**
 * Git sparse-checkout cones for release workflows (cone mode).
 * Contract tests keep workflow YAML aligned with job requirements.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { releaseOciInputSparseCones } from "../ci/release-oci-affected.mts";
import { loadReleaseOciManifest } from "./release-oci-contract.mts";

/** Repo-root files listed explicitly in sparse cones (not directory cones). */
export const RELEASE_ROOT_FILES = [
	"mise.toml",
	"mise.lock",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"turbo.json",
	"tsconfig.base.json",
] as const;

export const PINS_SPARSE_CONES = ["tools/pins"] as const;
export const MISE_LOCK_SPARSE_CONES = [".mise/locks"] as const;

export const PINS_REQUIRED_FILES = ["tools/pins/siblings.json"] as const;

/** Paths `pnpm run pins:fetch` reads before submodule checkout. */
export const PINS_FETCH_REQUIRED_FILES = [
	...PINS_REQUIRED_FILES,
	"scripts/bootstrap-siblings.mts",
] as const;

/** Parse root vitest.config.ts globalSetup + setupFiles (release jobs use root vitest). */
export function rootVitestSetupFiles(repoRoot: string): readonly string[] {
	const configPath = join(repoRoot, "vitest.config.ts");
	const src = readFileSync(configPath, "utf8");
	const rel: string[] = [];
	for (const match of src.matchAll(
		/new URL\("\.\/([^"]+)",\s*import\.meta\.url\)/g,
	)) {
		rel.push(match[1]!);
	}
	if (rel.length === 0) {
		throw new Error(
			`${configPath}: no setup paths found for sparse cone contract`,
		);
	}
	return Object.freeze(rel);
}

/** Minimal directory cones so every root vitest setup file is checked out. */
export function rootVitestSparseCones(repoRoot: string): readonly string[] {
	const files = rootVitestSetupFiles(repoRoot);
	const cones = new Set<string>();
	for (const file of files) {
		if (file.startsWith("test/")) {
			cones.add("test/setup");
			continue;
		}
		// packages/… is already covered by the packages cone in release workflows.
		const parts = file.split("/");
		if (parts[0] === "packages" && parts.length > 1) {
			continue;
		}
		cones.add(dirname(file) === "." ? file : dirname(file));
	}
	return Object.freeze([...cones].sort());
}

export function coneCoversPath(
	cones: readonly string[],
	repoRelativePath: string,
): boolean {
	const normalized = repoRelativePath.replace(/^\.\//, "");
	for (const cone of cones) {
		if (normalized === cone) return true;
		if (normalized.startsWith(`${cone}/`)) return true;
	}
	return false;
}

export function assertConeCoversPaths(
	jobLabel: string,
	cones: readonly string[],
	required: readonly string[],
): void {
	const missing = required.filter((path) => !coneCoversPath(cones, path));
	if (missing.length > 0) {
		throw new Error(
			`${jobLabel}: sparse cone missing required paths:\n${missing.map((p) => `  - ${p}`).join("\n")}\ncones: ${cones.join(", ")}`,
		);
	}
}

const HOBO_RELEASE_DIR_CONES = [
	".github",
	"scripts",
	"packages",
	"release",
	"deploy",
	"site",
	"external",
] as const;

/** HoBo release (npm + GHCR) jobs using RELEASE_SPARSE_PATHS. */
export function hoboReleaseSparseCones(repoRoot: string): readonly string[] {
	return Object.freeze([
		...new Set([
			...HOBO_RELEASE_DIR_CONES,
			...releaseOciInputSparseCones(),
			...PINS_SPARSE_CONES,
			...MISE_LOCK_SPARSE_CONES,
			...rootVitestSparseCones(repoRoot),
			...RELEASE_ROOT_FILES,
		]),
	]);
}

/** gh-pages release job (no root vitest). */
export function hoboReleasePagesSparseCones(): readonly string[] {
	return Object.freeze([
		".github",
		"scripts",
		"site",
		"packages",
		"docs",
		"release",
		"external",
		...PINS_SPARSE_CONES,
		...MISE_LOCK_SPARSE_CONES,
		...RELEASE_ROOT_FILES,
	]);
}

const CODE_RELEASE_DIR_CONES = [
	".agents",
	".claude",
	".github",
	"scripts",
	"packages",
	"external",
	"release",
	"deploy/release-images",
] as const;

/** HoBo Code release jobs with sparse checkout. */
export function hoboCodeReleaseSparseCones(
	repoRoot: string,
): readonly string[] {
	return Object.freeze([
		...new Set([
			...CODE_RELEASE_DIR_CONES,
			...releaseOciInputSparseCones(),
			...PINS_SPARSE_CONES,
			...MISE_LOCK_SPARSE_CONES,
			...rootVitestSparseCones(repoRoot),
			...RELEASE_ROOT_FILES,
		]),
	]);
}

/** ts-autocode release workflow sparse cone. */
export function tsAutocodeReleaseSparseCones(): readonly string[] {
	return Object.freeze([
		".github",
		"scripts",
		"packages",
		...PINS_SPARSE_CONES,
		...MISE_LOCK_SPARSE_CONES,
		"external",
		"package.json",
		"pnpm-lock.yaml",
		"pnpm-workspace.yaml",
		"mise.toml",
		"mise.lock",
	]);
}

/** Workspace paths root `pnpm install` needs so `ensure-ts-autocode-links` passes after pins:fetch. */
export const TS_AUTOCODE_PNPM_PREPARE_REQUIRED = [
	"packages/runtime/package.json",
	"external/ts-autocode/packages/grounding/package.json",
	"external/ts-autocode/packages/training/package.json",
	"external/ts-autocode/packages/rewrite/package.json",
] as const;

/** Vitest files run by HoBo / HoBo Code release contract jobs (static manifest checks). */
export const RELEASE_CONTRACT_VITEST_FILES = [
	"scripts/test/release-oci-affected.test.ts",
	"scripts/test/release-oci-image-contract.test.ts",
	"scripts/test/release-version.test.ts",
	"scripts/test/release-sparse-cone.test.ts",
	"scripts/test/stage-release-oci-app.test.ts",
] as const;

export const CODE_RELEASE_CONTRACT_VITEST_FILES = [
	"scripts/test/code-test-build-artifact.test.ts",
	...RELEASE_CONTRACT_VITEST_FILES,
] as const;

/** Repo-relative paths those tests read via join(root, …) or loadReleaseOciManifest. */
export function filePathsRequiredByReleaseOciContractTests(
	repoRoot: string,
): readonly string[] {
	const paths = new Set<string>(["release/npm-scope-map.json"]);
	const manifest = loadReleaseOciManifest(repoRoot);
	paths.add(join("release", "oci-images.json").replace(/\\/g, "/"));
	for (const image of manifest.images) {
		paths.add(image.dockerfile.replace(/\\/g, "/"));
	}
	for (const rel of [
		...RELEASE_CONTRACT_VITEST_FILES.filter(
			(f) => f !== "scripts/test/release-sparse-cone.test.ts",
		),
		"release/npm-scope-map.json",
	]) {
		const src = readFileSync(join(repoRoot, rel), "utf8");
		for (const match of src.matchAll(
			/join\(\s*root\s*,\s*["'`]([^"'`]+)["'`]/g,
		)) {
			paths.add(match[1]!.replace(/\\/g, "/"));
		}
	}
	return Object.freeze([...paths].sort());
}

export function filePathsRequiredByCodeReleaseContractTests(
	repoRoot: string,
): readonly string[] {
	const paths = new Set(filePathsRequiredByReleaseOciContractTests(repoRoot));
	for (const rel of CODE_RELEASE_CONTRACT_VITEST_FILES) {
		if (rel === "scripts/test/release-sparse-cone.test.ts") continue;
		const src = readFileSync(join(repoRoot, rel), "utf8");
		for (const match of src.matchAll(
			/join\(\s*root\s*,\s*["'`]([^"'`]+)["'`]/g,
		)) {
			paths.add(match[1]!.replace(/\\/g, "/"));
		}
	}
	return Object.freeze([...paths].sort());
}

export function formatSparseCheckoutBlock(cones: readonly string[]): string {
	return `${cones.join("\n")}\n`;
}

/** Git cone mode treats each pattern as a directory; root manifests are checked out separately. */
export function splitSparseCheckoutPaths(
	all: readonly string[],
	rootFileNames: readonly string[] = RELEASE_ROOT_FILES,
): {
	readonly directoryCones: readonly string[];
	readonly rootFiles: readonly string[];
} {
	const rootFileSet = new Set<string>(rootFileNames);
	const directoryCones: string[] = [];
	const rootFiles: string[] = [];
	for (const path of all) {
		const normalized = path.trim();
		if (!normalized) continue;
		if (rootFileSet.has(normalized)) {
			rootFiles.push(normalized);
			continue;
		}
		directoryCones.push(normalized);
	}
	return Object.freeze({
		directoryCones: Object.freeze([...directoryCones]),
		rootFiles: Object.freeze([...rootFiles]),
	});
}

/** Required on-disk paths per release sparse job (contract gate). */
export function requiredPathsForHoboReleaseContract(
	repoRoot: string,
): readonly string[] {
	return Object.freeze([
		...rootVitestSetupFiles(repoRoot),
		...PINS_FETCH_REQUIRED_FILES,
		...filePathsRequiredByReleaseOciContractTests(repoRoot),
	]);
}

export function requiredPathsForHoboCodeReleaseContract(
	repoRoot: string,
): readonly string[] {
	return Object.freeze([
		...rootVitestSetupFiles(repoRoot),
		...PINS_FETCH_REQUIRED_FILES,
		...filePathsRequiredByCodeReleaseContractTests(repoRoot),
	]);
}

export function requiredPathsForTsAutocodeReleaseContract(): readonly string[] {
	return Object.freeze([
		...PINS_FETCH_REQUIRED_FILES,
		...TS_AUTOCODE_PNPM_PREPARE_REQUIRED,
	]);
}

export function requiredPathsForHoboReleasePages(): readonly string[] {
	return Object.freeze([...PINS_FETCH_REQUIRED_FILES, "site/package.json"]);
}
