import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	decide,
	RELAY_DEPLOY_REQUIRED_VARIABLES,
	RELAY_EXTRA_INPUTS,
	relayInputDirs,
	touchesRelay,
} from "../ci/relay-deploy-gate.mts";
import { lintActionsRepository } from "../lint-actions.ts";

// The relay deploy workflow (.github/workflows/relay-deploy.yml) and its gate
// (scripts/ci/relay-deploy-gate.mts), ADR-0179 phase 6. Nothing here reaches
// GitHub, Infisical or Vercel.

const root = join(import.meta.dirname, "..", "..");
const workflowPath = join(root, ".github", "workflows", "relay-deploy.yml");
const workflow = readFileSync(workflowPath, "utf8");
const lockfile = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
const inputDirs = relayInputDirs(lockfile);
const configured = Object.fromEntries(
	RELAY_DEPLOY_REQUIRED_VARIABLES.map((name) => [name, "configured-id"]),
);

/** The block of one step, from its `- name:` line to the next step. */
function step(name: string): string {
	const lines = workflow.split("\n");
	const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
	assert.notEqual(start, -1, `no step named ${name}`);
	const end = lines.findIndex(
		(line, index) => index > start && /^ {6}- /u.test(line),
	);
	return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

describe("the relay deploy gate", () => {
	it("takes the relay and every workspace package it is built from as its inputs", () => {
		for (const dir of [
			"packages/ci-vercel",
			"packages/ci",
			"packages/ci-gh-actions",
			"packages/core",
			"packages/adapters/adapter-infisical",
			"packages/yards",
			"packages/camps",
		])
			assert.ok(inputDirs.includes(dir), `${dir} is not a relay input`);
		assert.ok(!inputDirs.includes("site"));
		for (const file of RELAY_EXTRA_INPUTS)
			assert.ok(existsSync(join(root, file)), `${file} does not exist`);
	});

	it("deploys a push that changes the relay or a package it uses, and only that", () => {
		assert.equal(
			touchesRelay(["packages/ci-vercel/deploy/yard.ts"], inputDirs),
			true,
		);
		assert.equal(touchesRelay(["packages/core/src/index.ts"], inputDirs), true);
		assert.equal(
			touchesRelay([".github/workflows/relay-deploy.yml"], inputDirs),
			true,
		);
		assert.equal(
			touchesRelay(["docs/design/index.md", "site/src/x.ts"], inputDirs),
			false,
		);
		// A sibling directory sharing a prefix is not an input.
		assert.equal(
			touchesRelay(["packages/ci-vercel-other/x.ts"], inputDirs),
			false,
		);
	});

	it("ends with a notice and no deploy until the owner has set the repository variables", () => {
		const decision = decide({
			event: "push",
			env: {},
			changed: ["packages/ci-vercel/src/entry.ts"],
			inputDirs,
		});
		assert.equal(decision.run, false);
		for (const name of RELAY_DEPLOY_REQUIRED_VARIABLES)
			assert.ok(decision.reason.includes(name));
		const partial = decide({
			event: "workflow_dispatch",
			env: { ...configured, HOBO_CI_RELAY_VERCEL_TEAM_ID: " " },
			inputDirs,
		});
		assert.equal(partial.run, false);
		assert.match(partial.reason, /HOBO_CI_RELAY_VERCEL_TEAM_ID/u);
	});

	it("deploys a manual run, and a push whose range it cannot read", () => {
		assert.equal(
			decide({ event: "workflow_dispatch", env: configured, inputDirs }).run,
			true,
		);
		assert.equal(
			decide({ event: "push", env: configured, inputDirs }).run,
			true,
		);
		assert.equal(
			decide({
				event: "push",
				env: configured,
				changed: ["README.md"],
				inputDirs,
			}).run,
			false,
		);
		assert.equal(
			decide({ event: "pull_request", env: configured, inputDirs }).run,
			false,
		);
	});
});

describe("the relay deploy workflow", () => {
	it("runs on a push to main and by hand, and nowhere else", () => {
		assert.match(
			workflow,
			/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n\n/mu,
		);
		assert.match(
			workflow,
			/if: github\.repository == 'Hobo-Labs\/HoBo' && github\.ref == 'refs\/heads\/main'/u,
		);
		assert.match(workflow, /cancel-in-progress: false/u);
	});

	it("may read the repository and mint an OIDC token, and nothing more", () => {
		assert.match(workflow, /^permissions:\n {2}contents: read\n/mu);
		assert.match(
			workflow,
			/ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/u,
		);
		assert.doesNotMatch(workflow, /write-all|secrets\.|\$\{\{\s*secrets/u);
	});

	it("reads its coordinates from repository variables, every one the gate requires", () => {
		for (const name of RELAY_DEPLOY_REQUIRED_VARIABLES)
			assert.ok(
				workflow.includes(`${name}: \${{ vars.${name} }}`),
				`${name} is not mapped from vars`,
			);
	});

	it("reads the deploy token through the config service, masked, before the deploy step", () => {
		const credential = step(
			"Read the Vercel deploy token (Infisical, GitHub OIDC)",
		);
		assert.match(
			credential,
			/node --import tsx scripts\/ci\/relay-deploy-credential\.mts/u,
		);
		const script = readFileSync(
			join(root, "scripts/ci/relay-deploy-credential.mts"),
			"utf8",
		);
		assert.match(script, /exportMaskedToGithubEnv\(/u);
		assert.ok(
			workflow.indexOf("relay-deploy-credential.mts") <
				workflow.indexOf("ci deploy \\"),
		);
		assert.doesNotMatch(
			workflow,
			/VERCEL_TOKEN:|--token\b|echo "\$VERCEL_TOKEN/u,
		);
	});

	it("delivers preview, then production, through HoBo CD from the Yard, attaching the cache and waiting", () => {
		const preview = step("Deliver the relay to preview through HoBo CD");
		for (const part of [
			"node packages/hobo/dist/bin/hobo.js ci deploy",
			"--cwd packages/ci-vercel",
			"--target preview",
			'--sha "$GITHUB_SHA"',
			"--provision --wait --json",
			'HOBO_HOME="$RUNNER_TEMP/hobo-home"',
		])
			assert.ok(preview.includes(part), `the preview step lacks ${part}`);
		const production = step("Promote the relay to production through HoBo CD");
		for (const part of [
			"node packages/hobo/dist/bin/hobo.js ci deploy",
			"--cwd packages/ci-vercel",
			"--target production",
			'--sha "$GITHUB_SHA"',
			'--set "INFISICAL_IDENTITY_ID=$HOBO_CI_RELAY_INFISICAL_IDENTITY_ID"',
			'--set "INFISICAL_PROJECT_ID=$HOBO_CI_RELAY_INFISICAL_PROJECT_ID"',
			"--provision --wait --json",
		])
			assert.ok(production.includes(part), `the production step lacks ${part}`);
		// Production after preview, in the journal preview wrote.
		assert.ok(
			workflow.indexOf("--target preview") <
				workflow.indexOf("--target production"),
		);
		assert.match(
			preview,
			/echo "HOBO_HOME=\$RUNNER_TEMP\/hobo-home" >> "\$GITHUB_ENV"/u,
		);
		// The provider and the project come from the Yard, not from here.
		for (const deploy of [preview, production])
			assert.doesNotMatch(deploy, /--project|--repo|vercel deploy|\|\| true/u);
		assert.match(
			step("Install the pinned Vercel CLI for Marketplace provisioning"),
			/add vercel@\d+\.\d+\.\d+ /u,
		);
	});

	it("verifies through CD's probes, not an ad-hoc smoke check", () => {
		assert.doesNotMatch(workflow, /curl /u);
		assert.doesNotMatch(workflow, /Smoke-check/u);
		for (const name of ["HOBO_CI_RELAY_URL", "HOBO_CI_RELAY_PREVIEW_URL"])
			assert.ok(
				RELAY_DEPLOY_REQUIRED_VARIABLES.some((required) => required === name),
				`${name} is not required by the gate`,
			);
	});

	it("passes the repository's workflow lint, as an approved CI fabric workflow", async () => {
		const previous = process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY;
		process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY = "1";
		try {
			const result = await lintActionsRepository(root);
			assert.equal(result.exitCode, 0, result.stderr);
		} finally {
			if (previous === undefined)
				delete process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY;
			else process.env.HOBO_LINT_ACTIONS_SKIP_REMOTE_PIN_VERIFY = previous;
		}
	});
});
