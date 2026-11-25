import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const PACKAGES_DIR = resolve(import.meta.dirname, "../..");

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

const FORBIDDEN_IN_UNRELATED_CI_PACKAGES = [
	"@hobo/ci-gh-actions",
	"runs-on",
	"workflow_job",
	"ubuntu-24.04",
	"ciGithubAppBindle",
] as const;

describe("GitHub isolation boundary for non-GitHub CI packages", () => {
	it("keeps @hobo/ci domain, cluster, host, and app.ts completely free of GitHub Actions specifics", () => {
		const files = [
			join(PACKAGES_DIR, "ci/src/app.ts"),
			...collectTypeScriptFiles(join(PACKAGES_DIR, "ci/src/domain")),
			...collectTypeScriptFiles(join(PACKAGES_DIR, "ci/src/cluster")),
			...collectTypeScriptFiles(join(PACKAGES_DIR, "ci/src/host")),
		];
		expect(files.length).toBeGreaterThan(0);

		const violations: string[] = [];
		for (const file of files) {
			const content = readFileSync(file, "utf8");
			for (const token of FORBIDDEN_IN_NEUTRAL_CI_CORE) {
				if (content.includes(token)) {
					violations.push(`${file} contains forbidden token "${token}"`);
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
			if (manifest.includes("@hobo/ci-gh-actions")) {
				violations.push(`${manifestPath} depends on @hobo/ci-gh-actions`);
			}

			for (const file of collectTypeScriptFiles(
				join(PACKAGES_DIR, pkg, "src"),
			)) {
				const content = readFileSync(file, "utf8");
				for (const token of FORBIDDEN_IN_UNRELATED_CI_PACKAGES) {
					if (content.includes(token)) {
						violations.push(`${file} contains forbidden token "${token}"`);
					}
				}
			}
		}

		const ciManifest = readFileSync(
			join(PACKAGES_DIR, "ci/package.json"),
			"utf8",
		);
		if (ciManifest.includes("@hobo/ci-gh-actions")) {
			violations.push(
				"packages/ci/package.json depends on @hobo/ci-gh-actions",
			);
		}

		expect(violations).toEqual([]);
	});
});
