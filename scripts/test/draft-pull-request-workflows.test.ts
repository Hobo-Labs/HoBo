import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	REQUIRED_PULL_REQUEST_TYPES,
	lintActionsRepository,
} from "../lint-actions.ts";
import { testRunner } from "./support/test-runner.ts";

const { describe, it } = await testRunner();

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowDir = join(repoRoot, ".github", "workflows");
const draftGate = /pull_request\.draft\s*==\s*false/;

function workflowsWithPullRequest(): string[] {
	return readdirSync(workflowDir)
		.filter((name) => /\.ya?ml$/i.test(name))
		.filter((name) =>
			/^\s*pull_request:/m.test(readFileSync(join(workflowDir, name), "utf8")),
		)
		.sort();
}

describe("draft pull request CI policy", () => {
	it("lists every workflow that listens on pull_request", () => {
		assert.deepEqual(workflowsWithPullRequest(), [
			"actions-lock.yml",
			"dev-env-smoke.yml",
			"examples-e2e.yml",
			"hobo-ci.yml",
			"pricing-ci.yml",
			"release-hobo-pr.yml",
			"release-hobo.yml",
			"release-pricing.yml",
			"release-ts-autocode.yml",
		]);
	});

	it("requires ready_for_review and a draft gate on each pull_request workflow", () => {
		for (const file of workflowsWithPullRequest()) {
			const text = readFileSync(join(workflowDir, file), "utf8");
			for (const type of REQUIRED_PULL_REQUEST_TYPES) {
				assert.match(
					text,
					new RegExp(`\\b${type}\\b`),
					`${file} must declare pull_request.types ${type}`,
				);
			}
			assert.match(
				text,
				draftGate,
				`${file} must gate draft pull_request runs`,
			);
		}
	});

	it("passes actions lint on the repository workflows", async () => {
		const result = await lintActionsRepository(repoRoot);
		assert.equal(result.exitCode, 0, `${result.stderr}\n${result.stdout}`);
	});
});
