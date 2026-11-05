import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseOciInputSparseCones } from "../ci/release-oci-affected.mts";
import {
	assertConeCoversPaths,
	coneCoversPath,
	filePathsRequiredByCodeReleaseContractTests,
	formatSparseCheckoutBlock,
	hoboCodeReleaseSparseCones,
	hoboReleasePagesSparseCones,
	hoboReleaseSparseCones,
	requiredPathsForHoboCodeReleaseContract,
	requiredPathsForHoboReleaseContract,
	requiredPathsForHoboReleasePages,
	requiredPathsForTsAutocodeReleaseContract,
	rootVitestSetupFiles,
	splitSparseCheckoutPaths,
	tsAutocodeReleaseSparseCones,
} from "../lib/release-sparse-cone.mts";

const root = join(import.meta.dirname, "..", "..");

function parseWorkflowEnvMultiline(
	workflowText: string,
	envName: string,
): string[] {
	const re = new RegExp(`${envName}:\\s*\\|\\n((?:    .+\\n)+)`);
	const match = workflowText.match(re);
	if (!match?.[1]) {
		throw new Error(`workflow missing ${envName} multiline env block`);
	}
	return match[1]
		.split("\n")
		.map((line) => line.replace(/^    /, "").trimEnd())
		.filter((line) => line.length > 0);
}

function parseInlineSparseCheckout(workflowText: string): string[] {
	const marker = "sparse-checkout: |";
	const start = workflowText.indexOf(marker);
	if (start < 0) {
		throw new Error("workflow missing sparse-checkout block");
	}
	return parseMultilineBlockAfterMarker(
		workflowText.slice(start + marker.length),
		"            ",
	);
}

/** Paths from a job's hobo-checkout `sparse-paths:` (inline block or env ref). */
function parseJobHoboCheckoutSparsePaths(
	workflowText: string,
	jobName: string,
): string[] {
	const jobStart = workflowText.indexOf(`${jobName}:`);
	if (jobStart < 0) {
		throw new Error(`workflow missing job ${jobName}`);
	}
	const jobBlock = workflowText.slice(jobStart);
	const checkoutMarker = "./.github/actions/hobo-checkout";
	const checkoutIdx = jobBlock.indexOf(checkoutMarker);
	if (checkoutIdx < 0) {
		throw new Error(`${jobName} missing hobo-checkout step`);
	}
	const stepBlock = jobBlock.slice(checkoutIdx);
	const inlineMarker = "sparse-paths: |";
	const inlineStart = stepBlock.indexOf(inlineMarker);
	if (inlineStart >= 0) {
		return parseMultilineBlockAfterMarker(
			stepBlock.slice(inlineStart + inlineMarker.length),
			"            ",
		);
	}
	const envRef = stepBlock.match(
		/sparse-paths:\s*\$\{\{\s*env\.([A-Z0-9_]+)\s*\}\}/,
	);
	if (!envRef?.[1]) {
		throw new Error(`${jobName} hobo-checkout missing sparse-paths`);
	}
	return parseWorkflowEnvMultiline(workflowText, envRef[1]);
}

function parseMultilineBlockAfterMarker(
	afterMarker: string,
	linePrefix: string,
): string[] {
	const lines: string[] = [];
	for (const line of afterMarker.split("\n")) {
		if (!line.startsWith(linePrefix) && lines.length > 0) break;
		if (line.startsWith(linePrefix)) {
			const path = line.slice(linePrefix.length).trimEnd();
			if (path) lines.push(path);
		}
	}
	return lines;
}

function sortedPaths(paths: readonly string[]): string[] {
	return [...paths].sort();
}

describe("release sparse cone requirements", () => {
	it("derives root vitest setup paths from vitest.config.ts", () => {
		const files = rootVitestSetupFiles(root);
		expect(files).toContain("test/setup/hobo-test-homes.ts");
		expect(files).toContain("test/setup/isolate-hobo-home.ts");
		for (const file of files) {
			expect(coneCoversPath(hoboReleaseSparseCones(root), file)).toBe(true);
		}
	});

	it("every release cone includes turbo's mise lock sidecars", () => {
		const sidecars = [
			".mise/locks/turbo/2.11.10/aube-lock.yaml",
			".mise/locks/turbo/2.11.10/package.json",
		];
		const cones = [
			hoboReleaseSparseCones(root),
			hoboReleasePagesSparseCones(),
			hoboCodeReleaseSparseCones(root),
			tsAutocodeReleaseSparseCones(),
		];
		for (const cone of cones) {
			for (const sidecar of sidecars) {
				expect(coneCoversPath(cone, sidecar), sidecar).toBe(true);
			}
		}
	});

	it("hobo release contract cone covers vitest setup and pins", () => {
		const cones = hoboReleaseSparseCones(root);
		assertConeCoversPaths(
			"hobo-release-contract",
			cones,
			requiredPathsForHoboReleaseContract(root),
		);
	});

	it("hobo code release contract cone covers vitest setup and pins", () => {
		const cones = hoboCodeReleaseSparseCones(root);
		assertConeCoversPaths(
			"hobo-code-release-contract",
			cones,
			requiredPathsForHoboCodeReleaseContract(root),
		);
	});

	it("hobo code release cone covers harness skill roots", () => {
		assertConeCoversPaths(
			"hobo-code-release-harness",
			hoboCodeReleaseSparseCones(root),
			[".agents/skills", ".claude/skills"],
		);
	});

	it("hobo code release contract cone covers OCI input pathspec directories", () => {
		const required = releaseOciInputSparseCones();
		expect(required).toEqual(
			expect.arrayContaining(["examples", "media", "site", "src"]),
		);
		expect(required).not.toContain("package.json");
		assertConeCoversPaths(
			"hobo-code-release-oci-inputs",
			hoboCodeReleaseSparseCones(root),
			required,
		);
	});

	it("hobo code release contract cone covers OCI manifest dockerfiles", () => {
		const required = filePathsRequiredByCodeReleaseContractTests(root);
		const dockerfiles = required.filter((p) =>
			p.startsWith("deploy/release-images/"),
		);
		expect(dockerfiles.length).toBeGreaterThan(1);
		const cones = hoboCodeReleaseSparseCones(root);
		for (const path of dockerfiles) {
			expect(coneCoversPath(cones, path), path).toBe(true);
		}
	});

	it("hobo release pages cone covers pins fetch", () => {
		assertConeCoversPaths(
			"hobo-release-pages",
			hoboReleasePagesSparseCones(),
			requiredPathsForHoboReleasePages(),
		);
	});

	it("ts-autocode release cone covers pins manifest", () => {
		assertConeCoversPaths(
			"ts-autocode-release-contract",
			tsAutocodeReleaseSparseCones(),
			requiredPathsForTsAutocodeReleaseContract(),
		);
	});
});

describe("release-ts-autocode workflow install order", () => {
	const tsWorkflow = readFileSync(
		join(root, ".github/workflows/release-ts-autocode.yml"),
		"utf8",
	);

	it("runs pins:fetch before root pnpm install", () => {
		const fetchIdx = tsWorkflow.indexOf("pnpm run pins:fetch ts-autocode");
		const installIdx = tsWorkflow.indexOf(
			"pnpm install --frozen-lockfile --config.confirmModulesPurge=false",
		);
		expect(fetchIdx).toBeGreaterThan(0);
		expect(installIdx).toBeGreaterThan(fetchIdx);
	});
});

describe("release-hobo affected image job", () => {
	const hoboWorkflow = readFileSync(
		join(root, ".github/workflows/release-hobo.yml"),
		"utf8",
	);

	it("reuses the Fabric deps layer instead of always installing", () => {
		expect(hoboWorkflow).toContain("Link deps layer or install");
		expect(hoboWorkflow).toContain("deps-layer.mts check --require");
		expect(hoboWorkflow).toContain(
			"reusing HOBO_CI_DEPS_LAYER=${HOBO_CI_DEPS_LAYER}; skip pnpm install",
		);
		expect(hoboWorkflow).toContain(
			"pnpm install --frozen-lockfile --config.confirmModulesPurge=false",
		);
	});

	it("builds independent images in parallel and mcp after cli", () => {
		expect(hoboWorkflow).toContain(
			'if [ "$id" = "hobo-mcp" ]; then continue; fi',
		);
		expect(hoboWorkflow).toContain("build_one");
		expect(hoboWorkflow).toContain(
			'if [[ " $IMAGE_IDS " == *" hobo-mcp "* ]]; then',
		);
	});
});

describe("release workflow shell lint diff base", () => {
	const hoboWorkflow = readFileSync(
		join(root, ".github/workflows/release-hobo.yml"),
		"utf8",
	);
	const codeWorkflow = readFileSync(
		join(root, ".github/workflows/release-code.yml"),
		"utf8",
	);

	for (const [label, workflow] of [
		["release-hobo", hoboWorkflow],
		["release-code", codeWorkflow],
	] as const) {
		it(`${label} lint:shell:changed uses HEAD^1 (sparse checkout has no origin/main)`, () => {
			expect(workflow).toContain(
				"pnpm run lint:shell:changed -- --base=HEAD^1",
			);
			expect(workflow).not.toMatch(
				/lint:shell:changed[^\n]*--base=origin\/main/,
			);
		});
	}
});

describe("release workflow sparse-checkout sync", () => {
	const hoboWorkflow = readFileSync(
		join(root, ".github/workflows/release-hobo.yml"),
		"utf8",
	);
	const codeWorkflow = readFileSync(
		join(root, ".github/workflows/release-code.yml"),
		"utf8",
	);
	const tsWorkflow = readFileSync(
		join(root, ".github/workflows/release-ts-autocode.yml"),
		"utf8",
	);

	it("release-hobo RELEASE_SPARSE_PATHS matches canonical cone", () => {
		const inWorkflow = parseWorkflowEnvMultiline(
			hoboWorkflow,
			"RELEASE_SPARSE_PATHS",
		);
		expect(sortedPaths(inWorkflow)).toEqual(
			sortedPaths(hoboReleaseSparseCones(root)),
		);
	});

	it("release-hobo pages job sparse-paths matches canonical cone", () => {
		const inWorkflow = parseJobHoboCheckoutSparsePaths(
			hoboWorkflow,
			"release-pages",
		);
		expect(sortedPaths(inWorkflow)).toEqual(
			sortedPaths(hoboReleasePagesSparseCones()),
		);
	});

	it("release-code CODE_RELEASE_SPARSE_PATHS matches canonical cone", () => {
		const inWorkflow = parseWorkflowEnvMultiline(
			codeWorkflow,
			"CODE_RELEASE_SPARSE_PATHS",
		);
		expect(sortedPaths(inWorkflow)).toEqual(
			sortedPaths(hoboCodeReleaseSparseCones(root)),
		);
	});

	it("release-ts-autocode sparse-checkout matches canonical cone", () => {
		const inWorkflow = parseInlineSparseCheckout(tsWorkflow);
		expect(sortedPaths(inWorkflow)).toEqual(
			sortedPaths(tsAutocodeReleaseSparseCones()),
		);
	});

	it("formatSparseCheckoutBlock is stable newline-separated paths", () => {
		const block = formatSparseCheckoutBlock(["scripts", "test/setup"]);
		expect(block).toBe("scripts\ntest/setup\n");
	});

	it("splitSparseCheckoutPaths separates root files from directory cones", () => {
		const split = splitSparseCheckoutPaths([
			"scripts",
			"mise.toml",
			"packages",
			"package.json",
		]);
		expect([...split.directoryCones].sort()).toEqual(["packages", "scripts"]);
		expect([...split.rootFiles].sort()).toEqual(["mise.toml", "package.json"]);
	});

	it("hobo-checkout checks out sparse root files after cone clone", () => {
		const action = readFileSync(
			join(root, ".github/actions/hobo-checkout/action.yml"),
			"utf8",
		);
		expect(action).toMatch(/Checkout sparse root files \(non-cone\)/);
		expect(action).toMatch(
			/ROOT_FILES: \$\{\{ steps\.sparse\.outputs\.root_files \}\}/,
		);
		expect(action).not.toMatch(
			/git checkout HEAD -- \$\{\{ steps\.sparse\.outputs\.root_files \}\}/,
		);
		expect(action).toMatch(/git checkout HEAD -- "\$\{root\[@\]\}"/);
		expect(action).toMatch(/git sparse-checkout add --skip-checks -- "\$path"/);
		expect(action).not.toMatch(/git checkout HEAD -- "\$\{paths\[@\]\}"/);
	});
});
