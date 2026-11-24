import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { checkDomainBoundaries } from "../check-domain-boundaries.mts";

const repoRoot = join(import.meta.dirname, "../..");

function withTempWorkspace(run: (root: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "hobo-domain-boundaries-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("checkDomainBoundaries", () => {
	it("passes on the real repository and covers all four Alchemy Domain models", () => {
		const report = checkDomainBoundaries(repoRoot);
		assert.deepEqual(report.violations, []);
		assert.ok(report.checkedModels.includes("packages/ci"));
		assert.ok(report.checkedModels.includes("packages/cd"));
		assert.ok(report.checkedModels.includes("packages/broker"));
		assert.ok(report.checkedModels.includes("packages/stations"));
	});

	it("fails closed when a domain module imports raw I/O packages", () => {
		withTempWorkspace((root) => {
			const domainDir = join(root, "packages", "sample", "src", "domain");
			mkdirSync(domainDir, { recursive: true });
			writeFileSync(
				join(domainDir, "bad.ts"),
				'import { readFileSync } from "node:fs";\nimport pg from "pg";\nexport const x = [readFileSync, pg];\n',
			);

			const report = checkDomainBoundaries(root);
			assert.equal(report.violations.length, 2);
			assert.ok(
				report.violations.every(
					(violation) => violation.rule === "domain-no-raw-io",
				),
			);
		});
	});

	it("fails closed when Domain.Model lacks Domain.verify or Story.make BDD tests", () => {
		withTempWorkspace((root) => {
			const domainDir = join(root, "packages", "sample", "src", "domain");
			const testDir = join(root, "packages", "sample", "test");
			mkdirSync(domainDir, { recursive: true });
			mkdirSync(testDir, { recursive: true });
			writeFileSync(
				join(domainDir, "model.ts"),
				'import * as Domain from "@alchemy.run/domain";\nexport const SampleModel = Domain.Model("Sample", {});\n',
			);
			writeFileSync(
				join(testDir, "sample.test.ts"),
				"export const ok = true;\n",
			);

			const report = checkDomainBoundaries(root);
			assert.deepEqual(
				report.violations.map((violation) => violation.rule),
				["domain-verify-required", "domain-story-required"],
			);
		});
	});

	it("fails closed when Domain.Event or Domain.Aggregate declares secret-shaped schema fields", () => {
		withTempWorkspace((root) => {
			const domainDir = join(root, "packages", "sample", "src", "domain");
			mkdirSync(domainDir, { recursive: true });
			writeFileSync(
				join(domainDir, "secret.ts"),
				'import * as Domain from "@alchemy.run/domain";\nimport * as Schema from "effect/Schema";\nexport const Bad = Domain.Event("Bad", { apiKey: Schema.String, token: Schema.String });\n',
			);

			const report = checkDomainBoundaries(root);
			assert.equal(report.violations.length, 2);
			assert.ok(
				report.violations.every(
					(violation) => violation.rule === "domain-no-secret-fields",
				),
			);
		});
	});
});
