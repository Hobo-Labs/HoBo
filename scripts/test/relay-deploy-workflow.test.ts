import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	decide,
	RELAY_EXTRA_INPUTS,
	RELAY_SECRET_STORE_BINDING,
	relayInputDirs,
	storeBindingState,
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
const configured = "bound" as const;

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

	it("ends with a notice and no deploy until a secret store is bound, and names how one is", () => {
		const decision = decide({
			event: "push",
			store: "absent",
			changed: ["packages/ci-vercel/src/entry.ts"],
			inputDirs,
		});
		assert.equal(decision.run, false);
		assert.ok(decision.reason.includes(RELAY_SECRET_STORE_BINDING));
		assert.match(decision.reason, /hobo ci secret-store provision/u);
		const broken = decide({
			event: "workflow_dispatch",
			store: "unreadable",
			inputDirs,
		});
		assert.equal(broken.run, false);
	});

	it("reads the binding's shape only, and only an HTTPS endpoint counts", () => {
		assert.equal(storeBindingState(undefined), "absent");
		assert.equal(storeBindingState("not json"), "unreadable");
		assert.equal(
			storeBindingState(
				JSON.stringify({ kind: "infisical-self-hosted", endpoint: "http://x" }),
			),
			"unreadable",
		);
		assert.equal(
			storeBindingState(
				JSON.stringify({
					kind: "infisical-self-hosted",
					endpoint: "https://secrets.example",
				}),
			),
			"bound",
		);
	});

	it("deploys a manual run, and a push whose range it cannot read", () => {
		assert.equal(
			decide({ event: "workflow_dispatch", store: configured, inputDirs }).run,
			true,
		);
		assert.equal(
			decide({ event: "push", store: configured, inputDirs }).run,
			true,
		);
		assert.equal(
			decide({
				event: "push",
				store: configured,
				changed: ["README.md"],
				inputDirs,
			}).run,
			false,
		);
		assert.equal(
			decide({ event: "pull_request", store: configured, inputDirs }).run,
			false,
		);
	});
});

describe("the relay deploy workflow", () => {
	it("runs on a push to main and by hand, and nowhere else", () => {
		assert.match(
			workflow,
			/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n {4}inputs:\n/mu,
		);
		// The only dispatch inputs: the App's one-time code and two ids.
		assert.deepEqual(
			[...workflow.matchAll(/^ {6}([a-z_]+):\n {8}description:/gmu)].map(
				(match) => match[1],
			),
			["manifest_code", "relay", "owner_id"],
		);
		assert.match(
			workflow,
			/if: github\.repository == 'Hobo-Labs\/HoBo' && github\.ref == 'refs\/heads\/main'/u,
		);
		assert.match(workflow, /cancel-in-progress: false/u);
	});

	it("may read the repository and its deployments and mint an OIDC token, and nothing more", () => {
		assert.match(workflow, /^permissions:\n {2}contents: read\n/mu);
		assert.match(
			workflow,
			/ {4}permissions:\n {6}contents: read\n {6}deployments: read\n {6}id-token: write\n/u,
		);
		assert.match(
			workflow,
			/ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/u,
		);
		assert.doesNotMatch(workflow, /write-all|secrets\.|\$\{\{\s*secrets/u);
	});

	it("reads no repository variable or secret for the relay's configuration", () => {
		// Runner routing reads its own variables; nothing about the relay does.
		for (const line of workflow.split("\n"))
			if (line.includes("vars."))
				assert.match(
					line,
					/vars\.HOBO_CI_(ROUTE|LOCAL_RUNNER|ROUTE_MAX_WAIT_SECONDS|ROUTE_MAX_QUEUED|TRUNK_RUNNER)\b/u,
					line,
				);
		assert.doesNotMatch(
			workflow,
			/INFISICAL_|VERCEL_TEAM_ID|HOBO_CI_RELAY_URL/u,
		);
	});

	it("routes the deploy like hobo-ci.yml, so a busy fleet does not hold it", () => {
		assert.match(workflow, /^ {2}route:\n/mu);
		assert.match(workflow, /uses: \.\/\.github\/actions\/route-runner/u);
		assert.match(workflow, / {4}needs: route\n/u);
		assert.match(
			workflow,
			/runs-on: \$\{\{ needs\.route\.outputs\.runner \|\| /u,
		);
	});

	it("holds no Vercel token and makes no Vercel API write: Vercel's Git integration deploys", () => {
		assert.doesNotMatch(
			workflow,
			/VERCEL_TOKEN|relay-deploy-credential|ci deploy|vercel@\d|vercel deploy|--token\b/u,
		);
		assert.ok(
			!existsSync(join(root, "scripts/ci/relay-deploy-credential.mts")),
		);
		const find = step("Find Vercel's Git deployment of this commit");
		assert.match(find, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
		assert.match(
			find,
			/repos\/\$GITHUB_REPOSITORY\/deployments\?sha=\$GITHUB_SHA/u,
		);
		assert.match(find, /test\("hobo-ci"\)/u);
		assert.match(find, /environment_url/u);
	});

	it("verifies the secret store's CI identity by name before looking for the deployment", () => {
		const verify = step("Verify the secret store connection");
		assert.match(
			verify,
			/node packages\/hobo\/dist\/bin\/hobo\.js ci secret-store verify/u,
		);
		assert.match(verify, /relay-deploy-secret-store-verify-report\.mts/u);
		assert.doesNotMatch(verify, /\|\| true/u);
		assert.ok(
			workflow.indexOf("ci secret-store verify") <
				workflow.indexOf("Find Vercel's Git deployment of this commit"),
		);
	});

	it("deposits the GitHub App's credentials with OIDC only when handed a manifest code, masked first", () => {
		assert.match(
			workflow,
			/ {2}app-credentials:\n[\s\S]*?if: [^\n]*github\.event\.inputs\.manifest_code != ''/u,
		);
		assert.match(
			workflow,
			/ {2}deploy:\n[\s\S]*?if: [^\n]*github\.event\.inputs\.manifest_code == ''/u,
		);
		const mask = step("Mask the one-time manifest code");
		assert.match(mask, /::add-mask::\$HOBO_APP_MANIFEST_CODE/u);
		const deposit = step(
			"Convert the manifest code and store the credentials (GitHub OIDC)",
		);
		assert.match(deposit, /ci app deposit/u);
		// The code reaches the command through the environment, never argv.
		assert.doesNotMatch(
			deposit,
			/--code|\$\{\{ github\.event\.inputs\.manifest_code \}\}"/u,
		);
		assert.ok(
			workflow.indexOf("Mask the one-time manifest code") <
				workflow.indexOf("ci app deposit"),
		);
	});

	it("fails the smoke check on a 5xx from /healthz only, and reports /readyz", () => {
		const smoke = step("Smoke-check /healthz and /readyz");
		assert.match(smoke, /5\?\?\) echo "::error/u);
		assert.match(smoke, /probe \/readyz/u);
		assert.doesNotMatch(smoke.slice(smoke.indexOf("probe /readyz")), /exit 1/u);
	});

	describe("probes the public origin", () => {
		const name = "Probe the fleet verdict at the public origin";

		/** The step's body check, run as the workflow runs it. */
		function judge(body: string, repository = "Hobo-Labs/HoBo") {
			const probe = step(name);
			const match = /node -e '([^']+)' "\$RUNNER_TEMP\/verdict\.json"/u.exec(
				probe,
			);
			assert.ok(match, "the step judges the answer with one node -e script");
			const dir = mkdtempSync(join(tmpdir(), "relay-verdict-probe-"));
			try {
				const file = join(dir, "verdict.json");
				writeFileSync(file, body);
				return spawnSync(process.execPath, ["-e", match[1] ?? "", file], {
					encoding: "utf8",
					env: { ...process.env, GITHUB_REPOSITORY: repository },
				});
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		}

		it("reads the relay's public origin from .hobo/ci.json, not the deployment URL", () => {
			const probe = step(name);
			assert.match(probe, /\.hobo\/ci\.json/u);
			assert.match(probe, /defaultEnvironment/u);
			assert.match(probe, /relayOrigin/u);
			assert.match(probe, /https:/u);
			assert.doesNotMatch(probe, /DEPLOYMENT_URL/u);
			assert.match(probe, /\/v1\/fleet\/verdicts\/\$\{?repository/u);
			assert.match(probe, /if: steps\.gate\.outputs\.run == 'true'/u);
		});

		it("runs after the existing checks, so it reports on what Vercel already deployed", () => {
			assert.ok(
				workflow.indexOf(`- name: ${name}`) >
					workflow.indexOf("- name: Smoke-check /healthz and /readyz"),
			);
			assert.ok(
				workflow.indexOf(`- name: ${name}`) <
					workflow.indexOf("  app-credentials:"),
			);
		});

		it("is red, naming the rollback order, unless the read answers 200", () => {
			const probe = step(name);
			assert.match(probe, /\[ "\$code" != "200" \]/u);
			assert.match(probe, /::error title=Relay fleet verdict::/u);
			assert.match(probe, /exit 1/u);
			assert.match(probe, /6\.10|rollback/iu);
		});

		it("accepts a verdict for this repository with a blocked object", () => {
			const open = judge(
				JSON.stringify({ repository: "hobo-labs/hobo", blocked: {} }),
			);
			assert.equal(open.status, 0, open.stderr);
			const blocked = judge(
				JSON.stringify({
					repository: "hobo-labs/hobo",
					blocked: { hobo: { reason: "no-capacity" } },
					observedAt: "2026-11-12T11:14:00.000Z",
				}),
			);
			assert.equal(blocked.status, 0, blocked.stderr);
		});

		it("refuses an answer that is not a verdict for this repository", () => {
			for (const body of [
				"",
				"not json",
				"[]",
				JSON.stringify({ blocked: {} }),
				JSON.stringify({ repository: "other/repo", blocked: {} }),
				JSON.stringify({ repository: "hobo-labs/hobo" }),
				JSON.stringify({ repository: "hobo-labs/hobo", blocked: [] }),
				JSON.stringify({ repository: "hobo-labs/hobo", blocked: null }),
				JSON.stringify({ status: "config-unavailable" }),
			]) {
				const result = judge(body);
				assert.notEqual(result.status, 0, `accepted ${body}`);
			}
		});
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
