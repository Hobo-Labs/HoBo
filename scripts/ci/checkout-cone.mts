import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	formatSparseCheckoutBlock,
	RELEASE_ROOT_FILES,
} from "../lib/release-sparse-cone.mts";

export const S0_DIRECTORY_CONES = [
	".agents",
	".changeset",
	".claude",
	".codex",
	".cursor",
	".devcontainer",
	".githooks",
	".github",
	".hobo",
	".impeccable",
	".mise",
	".optimizexp",
	".repo",
	"ast-grep",
	"contrib",
	"deploy",
	"docs",
	"examples",
	"external",
	"features",
	"packages",
	"plans",
	"release",
	"scripts",
	"site",
	"src",
	"test",
	"tools",
	"workflows",
] as const;

export const S0_ROOT_FILES = [
	...RELEASE_ROOT_FILES,
	".env.example",
	".gitattributes",
	".gitignore",
	".gitleaks.toml",
	".gitmodules",
	".mcp.json",
	"AGENTS.md",
	"AUTH.md",
	"CLAUDE.md",
	"CODE_OF_CONDUCT.md",
	"CONTRIBUTING.md",
	"DX.md",
	"GAPS.md",
	"LICENSE",
	"NOTES.md",
	"PRODUCT.md",
	"README.md",
	"SECURITY.md",
	"SUPPORT.md",
	"biome.json",
	"buf.gen.yaml",
	"cucumber.yaml",
	"konsistent.json",
	"oxlint.config.ts",
	"sgconfig.yml",
	"skills-lock.json",
	"stryker.scripts.conf.json",
	"tsconfig.json",
	"vitest.config.ts",
	"vitest.coverage.config.ts",
	"vitest.mutation.config.ts",
] as const;

export const S0_SPARSE_CONES = Object.freeze([
	...S0_DIRECTORY_CONES,
	...S0_ROOT_FILES,
]);

export const S0_REQUIRED_PATHS = [
	".gitleaks.toml",
	".github/actions/hobo-checkout/action.yml",
	"docs/ci/oci-layer-plan.md",
	"mise.toml",
	"mise.lock",
	"package.json",
	"packages/stage-gate/package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"scripts/bootstrap-siblings.mts",
	"scripts/ci/checkout-cone.mts",
	"scripts/run-relevant-checks.ts",
	"test/setup/hobo-test-homes.ts",
	"tools/pins/siblings.json",
	"turbo.json",
] as const;

export function s0SparseCones(repoRoot: string): readonly string[] {
	return Object.freeze(
		S0_SPARSE_CONES.filter(
			(path) => path !== ".githooks" || existsSync(join(repoRoot, ".githooks")),
		),
	);
}

export function s0SparsePathsBlock(
	repoRoot = join(import.meta.dirname, "..", ".."),
): string {
	return formatSparseCheckoutBlock(s0SparseCones(repoRoot));
}
