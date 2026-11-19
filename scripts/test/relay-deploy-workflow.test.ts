import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	adoptDeadline,
	decide,
	RELAY_DEPLOY_JOB_MARGIN_MINUTES,
	RELAY_DEPLOY_JOB_TIMEOUT_MINUTES,
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
			"packages/hobo",
			"packages/hobo-ci",
			"packages/hobo-cd",
			"packages/secret-store-claim",
			"packages/cli",
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
		assert.equal(touchesRelay(["pnpm-lock.yaml", ".npmrc"], inputDirs), true);
		assert.equal(
			touchesRelay(["packages/hobo/src/ci-relay-managed.ts"], inputDirs),
			true,
		);
		assert.equal(
			touchesRelay(["packages/secret-store-claim/src/infisical.ts"], inputDirs),
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

	it("deploys a manual run, and a push whose range it cannot read", () => {
		assert.equal(decide({ event: "workflow_dispatch", inputDirs }).run, true);
		assert.equal(decide({ event: "push", inputDirs }).run, true);
		assert.equal(
			decide({
				event: "push",
				changed: ["README.md"],
				inputDirs,
			}).run,
			false,
		);
		assert.equal(decide({ event: "pull_request", inputDirs }).run, false);
	});
});

describe("the relay deploy workflow", () => {
	it("runs on a push to main and by hand, and nowhere else", () => {
		assert.match(
			workflow,
			/^on:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/mu,
		);
		assert.match(
			workflow,
			/if: github\.repository == 'Hobo-Labs\/HoBo' && github\.ref == 'refs\/heads\/main'/u,
		);
		assert.match(workflow, /cancel-in-progress: false/u);
	});

	it("may read the repository, persist deployment checkpoints, and mint an OIDC token", () => {
		assert.match(workflow, /^permissions:\n {2}contents: read\n/mu);
		assert.match(
			workflow,
			/ {4}permissions:\n {6}contents: read\n {6}deployments: write\n {6}id-token: write\n/u,
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
		assert.match(workflow, /uses: \$\/\.github\/actions\/route-runner/u);
		assert.match(workflow, / {4}needs: route\n/u);
		assert.match(
			workflow,
			/runs-on: \$\{\{ needs\.route\.outputs\.runner \|\| /u,
		);
	});

	it("delivers the exact pushed commit through HoBo CD without a Git connection", () => {
		const deploy = step("Deliver the pinned relay through HoBo CD");
		assert.match(
			deploy,
			/node packages\/hobo\/dist\/bin\/hobo\.js ci deploy --managed/u,
		);
		assert.match(deploy, /--cwd packages\/ci-vercel/u);
		assert.match(deploy, /--sha "\$GITHUB_SHA"/u);
		assert.match(deploy, /--ref "\$GITHUB_REF_NAME"/u);
		assert.match(deploy, /exit "\$status"/u);
		assert.doesNotMatch(deploy, /--adopt|VERCEL_TOKEN|--token\b/u);
		assert.doesNotMatch(workflow, /protection-bypass|_vercel_share/iu);
	});

	it("reports a delivery refusal before preserving its nonzero exit status", () => {
		const work = mkdtempSync(join(tmpdir(), "relay-deploy-report-"));
		try {
			const bin = join(work, "packages/hobo/dist/bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(
				join(bin, "hobo.js"),
				'process.stdout.write(JSON.stringify({code:"HOBO_TEST_REFUSED",message:"deployment unavailable"})); process.exitCode = 27;',
			);
			const summary = join(work, "summary.md");
			const lines = step("Deliver the pinned relay through HoBo CD").split(
				"\n",
			);
			const start = lines.findIndex((line) => line.trim() === "run: |");
			assert.notEqual(start, -1);
			const script = lines
				.slice(start + 1)
				.map((line) => line.replace(/^ {10}/u, ""))
				.join("\n");
			const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], {
				cwd: work,
				encoding: "utf8",
				env: {
					...process.env,
					RUNNER_TEMP: work,
					GITHUB_STEP_SUMMARY: summary,
					GITHUB_SHA: "test",
					GITHUB_REF_NAME: "main",
					DEPLOY_DEADLINE: "test",
				},
			});
			assert.equal(result.status, 27);
			assert.match(result.stdout, /HOBO_TEST_REFUSED: deployment unavailable/u);
			assert.match(
				readFileSync(summary, "utf8"),
				/HOBO_TEST_REFUSED: deployment unavailable/u,
			);
		} finally {
			rmSync(work, { recursive: true, force: true });
		}
	});

	it("bounds the delivery by the gate deadline within the job timeout", () => {
		const deploy = /^ {2}deploy:\n([\s\S]*?)\n {4}steps:/mu.exec(workflow)?.[1];
		assert.ok(deploy);
		const jobTimeout = Number(
			/^ {4}timeout-minutes: (\d+)$/mu.exec(deploy)?.[1],
		);
		assert.equal(jobTimeout, RELAY_DEPLOY_JOB_TIMEOUT_MINUTES);
		assert.ok(jobTimeout <= 20);
		assert.ok(RELAY_DEPLOY_JOB_MARGIN_MINUTES >= 2);
		assert.equal(
			adoptDeadline(Date.UTC(2026, 10, 13, 12)),
			"2026-11-13T12:17:00.000Z",
		);
		const gate = step("Decide whether to deploy");
		assert.match(gate, /relay-deploy-gate\.mts/u);
		const delivery = step("Deliver the pinned relay through HoBo CD");
		assert.match(
			delivery,
			/DEPLOY_DEADLINE: \$\{\{ steps\.gate\.outputs\.deadline \}\}/u,
		);
		assert.match(delivery, /--deadline "\$DEPLOY_DEADLINE"/u);
		const stepTimeout = Number(/timeout-minutes: (\d+)/u.exec(delivery)?.[1]);
		assert.ok(stepTimeout >= jobTimeout - RELAY_DEPLOY_JOB_MARGIN_MINUTES);
	});

	it("leaves private binding validation to managed delivery", () => {
		assert.doesNotMatch(
			workflow,
			/ci secret-store verify|secret-store\.binding\.json/u,
		);
		assert.doesNotMatch(workflow, /manifest_code|owner_id|ci app deposit/u);
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

		it("runs after managed delivery", () => {
			assert.ok(
				workflow.indexOf(`- name: ${name}`) >
					workflow.indexOf("- name: Deliver the pinned relay through HoBo CD"),
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
