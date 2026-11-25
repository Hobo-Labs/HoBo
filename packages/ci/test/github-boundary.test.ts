import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCiNeutralImportAllowlist,
	hostLayerEscapeSpecifier,
	neutralCiCrossPackageImportViolation,
} from "../../../scripts/lib/ci-neutral-import-boundary.mts";
import { importSpecifiersOf } from "../../../scripts/lib/test-import-specifiers.mts";

const PACKAGES_DIR = resolve(import.meta.dirname, "../..");
const REPO_ROOT = resolve(PACKAGES_DIR, "..");

function collectTypeScriptFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const info = statSync(full);
		if (info.isDirectory()) {
			results.push(...collectTypeScriptFiles(full));
		} else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
			results.push(full);
		}
	}
	return results;
}

function stripNonCode(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const c = text[i];
		const next = text[i + 1];
		if (c === "/" && next === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
		} else if (c === "/" && next === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
				if (text[i] === "\n") out += "\n";
				i += 1;
			}
			i += 2;
		} else if (c === '"' || c === "'" || c === "`") {
			const quote = c;
			i += 1;
			while (i < text.length && text[i] !== quote) {
				if (text[i] === "\\") i += 1;
				else if (text[i] === "\n") out += "\n";
				i += 1;
			}
			i += 1;
			out += '""';
		} else {
			out += c;
			i += 1;
		}
	}
	return out;
}

function containsForbiddenToken(content: string, token: string): boolean {
	const lowerToken = token.toLowerCase();
	return stripNonCode(content).toLowerCase().includes(lowerToken);
}

const FORBIDDEN_IN_NEUTRAL_CI_CORE = [
	"@hobo/ci-gh-actions",
	"github",
	"GitHub",
	"runsOn",
	"RunsOn",
	"runs-on",
	"workflow_job",
	"ubuntu-24.04",
	"ciGithubAppBindle",
] as const;

const FORBIDDEN_IMPORTS_IN_NEUTRAL_CI_CORE = ["@hobo/ci-gh-actions"] as const;

const FORBIDDEN_IN_UNRELATED_CI_PACKAGES = [
	"@hobo/ci-gh-actions",
	"runs-on",
	"workflow_job",
	"ubuntu-24.04",
	"ciGithubAppBindle",
] as const;

describe("GitHub isolation boundary for non-GitHub CI packages", () => {
	it("keeps @hobo/ci domain, cluster, host, and app.ts completely free of GitHub Actions specifics", () => {
		const neutralCore = [
			join(PACKAGES_DIR, "ci/src/app.ts"),
			...collectTypeScriptFiles(join(PACKAGES_DIR, "ci/src/domain")),
			...collectTypeScriptFiles(join(PACKAGES_DIR, "ci/src/cluster")),
		];
		const files = [
			...neutralCore,
			...collectTypeScriptFiles(join(PACKAGES_DIR, "ci/src/host")),
		];
		expect(files.length).toBeGreaterThan(0);

		const violations: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, "utf8");
			for (const token of FORBIDDEN_IN_NEUTRAL_CI_CORE) {
				if (containsForbiddenToken(content, token)) {
					violations.push(`${file} contains forbidden token "${token}"`);
				}
			}
			for (const specifier of FORBIDDEN_IMPORTS_IN_NEUTRAL_CI_CORE) {
				for (const entry of importSpecifiersOf(content, file)) {
					if (
						entry.specifier === specifier ||
						entry.specifier.startsWith(`${specifier}/`)
					) {
						violations.push(
							`${file} imports forbidden module "${entry.specifier}"`,
						);
					}
				}
			}
		}
		for (const file of neutralCore) {
			const content = readFileSync(file, "utf8");
			for (const entry of importSpecifiersOf(content, file)) {
				if (hostLayerEscapeSpecifier(entry.specifier)) {
					violations.push(
						`${file} escapes into the host layer via "${entry.specifier}"`,
					);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it("flags host-layer and cross-package ci-gh-actions import escapes after normalization", () => {
		expect(hostLayerEscapeSpecifier("../host/rivet.js")).toBe(true);
		expect(hostLayerEscapeSpecifier(".././host/rivet.js")).toBe(true);
		expect(hostLayerEscapeSpecifier("../../ci-gh-actions/src/foo.js")).toBe(
			true,
		);
		expect(hostLayerEscapeSpecifier("../domain/ids.js")).toBe(false);
	});

	it("keeps @hobo/ci neutral domain imports inside the declared workspace dependency closure", () => {
		const allowlist = buildCiNeutralImportAllowlist(REPO_ROOT);
		expect(allowlist.has("@hobo/core")).toBe(true);
		expect(allowlist.has("@hobo/broker")).toBe(true);
		expect(allowlist.has("@hobo/ci-gh-actions")).toBe(false);

		const neutralCore = [
			join(PACKAGES_DIR, "ci/src/app.ts"),
			...collectTypeScriptFiles(join(PACKAGES_DIR, "ci/src/domain")),
			...collectTypeScriptFiles(join(PACKAGES_DIR, "ci/src/cluster")),
		];
		const violations: string[] = [];
		for (const file of neutralCore) {
			const content = readFileSync(file, "utf8");
			for (const entry of importSpecifiersOf(content, file)) {
				const violation = neutralCiCrossPackageImportViolation(
					file,
					entry.specifier,
					REPO_ROOT,
					allowlist,
				);
				if (violation !== null) {
					violations.push(`${file}: ${violation}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});

	it("keeps non-GitHub CI packages (ci-ado, ci-cf, ci-dagger) isolated from @hobo/ci-gh-actions and GitHub Actions runner logic", () => {
		const packages = ["ci-ado", "ci-cf", "ci-dagger"] as const;
		const violations: string[] = [];

		for (const pkg of packages) {
			const manifestPath = join(PACKAGES_DIR, pkg, "package.json");
			const manifest = readFileSync(manifestPath, "utf8");
			if (manifest.toLowerCase().includes("@hobo/ci-gh-actions")) {
				violations.push(`${manifestPath} depends on @hobo/ci-gh-actions`);
			}

			for (const file of collectTypeScriptFiles(
				join(PACKAGES_DIR, pkg, "src"),
			)) {
				const content = readFileSync(file, "utf8");
				for (const token of FORBIDDEN_IN_UNRELATED_CI_PACKAGES) {
					if (containsForbiddenToken(content, token)) {
						violations.push(`${file} contains forbidden token "${token}"`);
					}
				}
				for (const entry of importSpecifiersOf(content, file)) {
					if (
						entry.specifier === "@hobo/ci-gh-actions" ||
						entry.specifier.startsWith("@hobo/ci-gh-actions/")
					) {
						violations.push(
							`${file} imports forbidden module "${entry.specifier}"`,
						);
					}
				}
			}
		}

		const ciManifest = readFileSync(
			join(PACKAGES_DIR, "ci/package.json"),
			"utf8",
		);
		if (ciManifest.toLowerCase().includes("@hobo/ci-gh-actions")) {
			violations.push(
				"packages/ci/package.json depends on @hobo/ci-gh-actions",
			);
		}

		expect(violations).toEqual([]);
	});
});
