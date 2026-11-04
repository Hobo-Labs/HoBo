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
	const after = workflowText.slice(start + marker.length);
	const lines: string[] = [];
	for (const line of after.split("\n")) {
		if (!line.startsWith("            ") && lines.length > 0) break;
		if (line.startsWith("            ")) {
			const path = line.replace(/^            /, "").trimEnd();
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

	it("release-hobo pages job sparse-checkout matches canonical cone", () => {
		const pagesBlock = hoboWorkflow.slice(
			hoboWorkflow.indexOf("release-pages:"),
		);
		const inWorkflow = parseInlineSparseCheckout(pagesBlock);
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
});
