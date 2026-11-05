import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	S0_DIRECTORY_CONES,
	S0_FILE_PATHS,
	S0_INSTALL_REQUIRED_PATHS,
	S0_NESTED_FILES,
	S0_REQUIRED_PATHS,
	s0SparseCones,
	s0SparsePathsBlock,
} from "../ci/checkout-cone.mts";
import {
	assertConeCoversPaths,
	coneCoversPath,
	PINS_FETCH_REQUIRED_FILES,
	splitSparseCheckoutPaths,
	TS_AUTOCODE_PNPM_PREPARE_REQUIRED,
} from "../lib/release-sparse-cone.mts";

const root = join(import.meta.dirname, "..", "..");
const checkoutSha = "11bd71901bbe5b1630ceea73d27597364c9af683";
const workflow = readFileSync(
	join(root, ".github/workflows/hobo-ci.yml"),
	"utf8",
);
const mainGate = workflow.slice(
	workflow.indexOf("\n  main-gate:"),
	workflow.indexOf("\n  artifact-trust:"),
);
const action = readFileSync(
	join(root, ".github/actions/hobo-checkout/action.yml"),
	"utf8",
);

function mainGateSparsePaths(): string[] {
	const match = mainGate.match(/S0_SPARSE_PATHS: \|\n((?:        .+\n)+)/);
	if (!match?.[1]) throw new Error("main-gate missing S0_SPARSE_PATHS block");
	return match[1]
		.split("\n")
		.filter(Boolean)
		.map((line) => line.slice(8));
}

describe("Main full gate S0 sparse checkout", () => {
	it("keeps the workflow env block identical to the canonical cone", () => {
		expect(`${mainGateSparsePaths().join("\n")}\n`).toBe(
			s0SparsePathsBlock(root),
		);
	});

	it("bootstraps local actions before using hobo-checkout", () => {
		const bootstrap = mainGate.indexOf(`uses: actions/checkout@${checkoutSha}`);
		const localCheckout = mainGate.indexOf(
			"uses: ./.github/actions/hobo-checkout",
		);
		expect(bootstrap).toBeGreaterThan(-1);
		expect(localCheckout).toBeGreaterThan(bootstrap);
		expect(mainGate).toContain("sparse-checkout: .github/actions");
		expect(mainGate).not.toContain("submodules: recursive");
	});

	it("retains full history but skips submodules", () => {
		expect(mainGate).toMatch(
			/name: Checkout \(sparse S0, full history\)\n        uses: \.\/\.github\/actions\/hobo-checkout\n        with:\n          fetch-depth: 0\n          sparse-paths: \$\{\{ env\.S0_SPARSE_PATHS \}\}\n          submodules: "false"/,
		);
	});

	it("starts the secret scan after preflight through gitleaks-main-scan", () => {
		const checkout = mainGate.indexOf(
			"name: Checkout (sparse S0, full history)",
		);
		const preflight = mainGate.indexOf(
			"uses: ./.github/actions/ci-runner-preflight",
		);
		const start = mainGate.indexOf(
			"name: Start secret scan (full history, background)",
		);
		expect(preflight).toBeGreaterThan(checkout);
		expect(start).toBeGreaterThan(preflight);
		expect(mainGate).toContain("gitleaks-main-scan.mts --background");
		expect(mainGate).toContain("gitleaks-main-scan.mts --wait");
		const wait = mainGate.indexOf("name: Secret scan (full history)");
		const workspace = mainGate.indexOf("name: Workspace tests");
		const prune = mainGate.indexOf("name: Prune Turbo cache");
		expect(checkout).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(checkout);
		expect(wait).toBeGreaterThan(workspace);
		expect(prune).toBeGreaterThan(wait);
		const imageJob = workflow.slice(
			workflow.indexOf("\n  ci-runner-image:"),
			workflow.indexOf("\n  main-gate:"),
		);
		expect(imageJob).not.toContain(
			"Start secret scan (full history, background)",
		);
		expect(imageJob).not.toContain("Secret scan (full history)");
	});

	it("covers every required S0 input", () => {
		assertConeCoversPaths(
			"main-gate-s0",
			s0SparseCones(root),
			S0_REQUIRED_PATHS,
		);
		assertConeCoversPaths("main-gate-s0-pins", s0SparseCones(root), [
			...PINS_FETCH_REQUIRED_FILES,
			...TS_AUTOCODE_PNPM_PREPARE_REQUIRED,
		]);
	});

	it("would have failed job 127191339479 without the pin cone + pins:fetch", () => {
		// Exact prepare error from Main Fabric 42011481177 / job 127191339479:
		// ". prepare: Error: ts-autocode sibling packages are not linked
		//  (packages/runtime/node_modules/ts-autocode-grounding and
		//  ts-autocode-training cone); run `pnpm run pins:fetch` then `pnpm install`"
		const linker = readFileSync(
			join(root, "scripts/ensure-ts-autocode-links.mts"),
			"utf8",
		);
		expect(linker).toContain("ts-autocode sibling packages are not linked");
		expect(linker).toContain("pnpm run pins:fetch");
		assertConeCoversPaths(
			"main-gate-s0-install",
			s0SparseCones(root),
			S0_INSTALL_REQUIRED_PATHS,
		);
		for (const path of [
			"external/ts-autocode/packages/grounding/package.json",
			"external/ts-autocode/packages/training/package.json",
			"external/ts-autocode/packages/rewrite/package.json",
		]) {
			expect(S0_INSTALL_REQUIRED_PATHS).toContain(path);
			expect(coneCoversPath(s0SparseCones(root), path)).toBe(true);
		}
		expect(mainGate.indexOf("pnpm run pins:fetch ts-autocode")).toBeGreaterThan(
			-1,
		);
	});

	it("fetches the ts-autocode pin before deps-layer or install", () => {
		const fetch = mainGate.indexOf("pnpm run pins:fetch ts-autocode");
		const preflight = mainGate.indexOf(
			"uses: ./.github/actions/ci-runner-preflight",
		);
		const link = mainGate.indexOf("name: Link deps layer");
		const install = mainGate.indexOf("name: Install dependencies");
		expect(fetch).toBeGreaterThan(preflight);
		expect(link).toBeGreaterThan(fetch);
		expect(install).toBeGreaterThan(fetch);
		expect(mainGate).toContain(
			"external/ts-autocode/packages/grounding/package.json",
		);
		expect(mainGate).toContain(
			"external/ts-autocode/packages/training/package.json",
		);
		expect(mainGate).toContain(
			"external/ts-autocode/packages/rewrite/package.json",
		);
		expect(mainGate).not.toContain("submodules: recursive");
	});

	it("checks out media/package.json without the media asset tree", () => {
		expect(coneCoversPath(s0SparseCones(root), "media/package.json")).toBe(
			true,
		);
		expect(coneCoversPath(s0SparseCones(root), "media/src/index.ts")).toBe(
			false,
		);
		expect(S0_NESTED_FILES).toEqual(["media/package.json"]);
		expect(S0_INSTALL_REQUIRED_PATHS).toContain("media/package.json");
	});

	it("splits every S0 file path out of the directory cones", () => {
		const split = splitSparseCheckoutPaths(s0SparseCones(root), S0_FILE_PATHS);
		expect(split.directoryCones).toEqual(S0_DIRECTORY_CONES);
		expect(split.rootFiles).toEqual(S0_FILE_PATHS);
		const actionRootFiles = action.match(
			/root_files=\(\n((?:          .+\n)+?)        \)/,
		);
		expect(actionRootFiles?.[1]).toBe(
			`${S0_FILE_PATHS.map((path) => `          ${path}\n`).join("")}`,
		);
	});
});

describe("hobo-checkout mirror and partial clone contract", () => {
	it("retains the pinned blobless, tag-free, non-cleaning checkout", () => {
		expect(
			action.match(new RegExp(`actions/checkout@${checkoutSha}`, "g")),
		).toHaveLength(3);
		expect(action.match(/filter: blob:none/g)).toHaveLength(3);
		expect(action.match(/fetch-tags: false/g)).toHaveLength(3);
		expect(action.match(/clean: false/g)).toHaveLength(3);
	});

	it("probes the box mirror before any checkout attempt", () => {
		const probe = action.indexOf("box-git-mirror.mts");
		const stabilize = action.indexOf("Stabilize partial-clone HTTP");
		const checkout = action.indexOf(`uses: actions/checkout@${checkoutSha}`);
		expect(probe).toBeGreaterThan(-1);
		expect(probe).toBeLessThan(stabilize);
		expect(probe).toBeLessThan(checkout);
		expect(action).toContain('echo "GIT_CONFIG_SYSTEM=$cfg" >> "$GITHUB_ENV"');
	});
});
