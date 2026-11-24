import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	packageUsesEffect,
	selectEffectTsgoTargets,
	workspaceDirForPath,
} from "../check-effect-tsgo.mts";

function withTempWorkspace(run: (root: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), "hobo-effect-tsgo-"));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("check-effect-tsgo target selection", () => {
	it("resolves both top-level and nested workspace package paths", () => {
		assert.equal(
			workspaceDirForPath("packages/ci/src/index.ts"),
			"packages/ci",
		);
		assert.equal(
			workspaceDirForPath("packages/iac/iac-alchemy/src/index.ts"),
			"packages/iac/iac-alchemy",
		);
		assert.equal(
			workspaceDirForPath("packages/providers/provider-github/src/index.ts"),
			"packages/providers/provider-github",
		);
		assert.equal(workspaceDirForPath("docs/agent-tooling.md"), undefined);
	});

	it("selects only touched packages that declare Effect or Alchemy dependencies", () => {
		withTempWorkspace((root) => {
			const effectPkg = join(root, "packages", "ci");
			const plainPkg = join(root, "packages", "plain");
			const nestedAlchemyPkg = join(root, "packages", "iac", "iac-alchemy");
			mkdirSync(effectPkg, { recursive: true });
			mkdirSync(plainPkg, { recursive: true });
			mkdirSync(nestedAlchemyPkg, { recursive: true });

			writeFileSync(
				join(effectPkg, "package.json"),
				JSON.stringify({
					name: "@hobo/ci",
					dependencies: { effect: "4.1.4", "@alchemy.run/domain": "2.0.0" },
				}),
			);
			writeFileSync(join(effectPkg, "tsconfig.json"), "{}");

			writeFileSync(
				join(plainPkg, "package.json"),
				JSON.stringify({ name: "@hobo/plain", dependencies: { zod: "^4" } }),
			);
			writeFileSync(join(plainPkg, "tsconfig.json"), "{}");

			writeFileSync(
				join(nestedAlchemyPkg, "package.json"),
				JSON.stringify({
					name: "@hobo/iac-alchemy",
					dependencies: { alchemy: "2.0.0-beta.87" },
				}),
			);
			writeFileSync(join(nestedAlchemyPkg, "tsconfig.json"), "{}");

			assert.equal(packageUsesEffect(join(effectPkg, "package.json")), true);
			assert.equal(packageUsesEffect(join(plainPkg, "package.json")), false);

			const targets = selectEffectTsgoTargets(root, [
				"packages/ci/src/domain/CiFleet.model.ts",
				"packages/plain/src/index.ts",
				"packages/iac/iac-alchemy/src/runners/local.ts",
				"README.md",
			]);

			assert.deepEqual(targets, [
				{
					packageDir: "packages/ci",
					tsconfigPath: "packages/ci/tsconfig.json",
				},
				{
					packageDir: "packages/iac/iac-alchemy",
					tsconfigPath: "packages/iac/iac-alchemy/tsconfig.json",
				},
			]);
		});
	});
});
