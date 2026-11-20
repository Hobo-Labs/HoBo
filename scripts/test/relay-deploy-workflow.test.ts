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
	decide,
	deployDeadline,
	RELAY_DEPLOY_JOB_MARGIN_MINUTES,
	RELAY_DEPLOY_JOB_TIMEOUT_MINUTES,
	RELAY_EXTRA_INPUTS,
	RELAY_SECRET_STORE_BINDING,
	relayInputDirs,
	storeBindingState,
	touchesRelay,
} from "../ci/relay-deploy-gate.mts";
import { lintActionsRepository } from "../lint-actions.ts";

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

function stepBefore(first: string, second: string): void {
	const firstIndex = workflow.indexOf(`- name: ${first}`);
	const secondIndex = workflow.indexOf(`- name: ${second}`);
	assert.ok(firstIndex >= 0, `no step named ${first}`);
	assert.ok(secondIndex >= 0, `no step named ${second}`);
	assert.ok(firstIndex < secondIndex, `${first} must run before ${second}`);
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
			touchesRelay(["scripts/ci/relay-deploy-verify.mts"], inputDirs),
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

	it("treats a force_bootstrap run as an emergency bootstrap, whatever the diff", () => {
		const forced = decide({
			event: "workflow_dispatch",
			store: configured,
			inputDirs,
			forceBootstrap: true,
		});
		assert.equal(forced.run, true);
		assert.match(forced.reason, /emergency bootstrap/u);
		const plain = decide({
			event: "workflow_dispatch",
			store: configured,
			inputDirs,
			forceBootstrap: false,
		});
		assert.equal(plain.run, true);
		assert.doesNotMatch(plain.reason, /bootstrap/u);
		assert.equal(
			decide({
				event: "push",
				store: configured,
				changed: ["README.md"],
				inputDirs,
				forceBootstrap: true,
			}).run,
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
		const inputs = [
			...workflow.matchAll(/^ {6}([a-z_]+):\n {8}description:/gmu),
		].map((match) => match[1]);
		assert.deepEqual(inputs, [
			"manifest_code",
			"relay",
			"owner_id",
			"force_bootstrap",
		]);
		const bootstrap =
			/^ {6}force_bootstrap:\n {8}description:[^\n]*\n {8}required: false\n {8}default: false\n {8}type: boolean/mu;
		assert.match(workflow, bootstrap);
		assert.match(
			workflow,
			/if: github\.repository == 'Hobo-Labs\/HoBo' && github\.ref == 'refs\/heads\/main'/u,
		);
		assert.match(workflow, /cancel-in-progress: false/u);
	});

	it("passes force_bootstrap to the gate as FORCE_BOOTSTRAP, and only there", () => {
		const gate = step("Decide whether to deploy");
		assert.match(gate, /id: gate/u);
		assert.match(gate, /relay-deploy-gate\.mts/u);
		assert.match(
			gate,
			/FORCE_BOOTSTRAP: \$\{\{ github\.event\.inputs\.force_bootstrap \}\}/u,
		);
	});

	it("may read the repository and mint an OIDC token, and nothing more", () => {
		assert.match(workflow, /^permissions:\n {2}contents: read\n/mu);
		assert.match(
			workflow,
			/ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/u,
		);
		assert.doesNotMatch(workflow, /deployments:/u);
		assert.doesNotMatch(workflow, /GITHUB_TOKEN:/u);
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
		assert.doesNotMatch(workflow, /INFISICAL_|VERCEL_TEAM_ID/u);
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

	it("never adopts and never waits for a Git-linked deployment: it deploys directly", () => {
		assert.doesNotMatch(workflow, /--adopt\b/u);
		assert.doesNotMatch(workflow, /HOBO_CI_ADOPT_/u);
		const deploys = [...workflow.matchAll(/hobo\.js ci deploy\b/gu)];
		assert.equal(deploys.length, 2, "expected exactly two deploy commands");
		for (const name of [
			"Deploy the relay (preview)",
			"Deploy the relay (production)",
		]) {
			const deployStep = step(name)
				.split("\n")
				.map((line) => line.replace(/^ {10}/u, "").replace(/\\\n?/u, " "))
				.join(" ");
			assert.match(deployStep, /hobo\.js ci deploy/u);
			assert.match(deployStep, /--cwd packages\/ci-vercel/u);
			assert.match(deployStep, /--sha "\$GITHUB_SHA"/u);
			assert.match(deployStep, /--ref "\$GITHUB_REF_NAME"/u);
			assert.match(deployStep, /--provision --wait/u);
			assert.match(deployStep, /--deadline "\$DEPLOY_DEADLINE"/u);
			assert.match(deployStep, /exit "\$status"/u);
			assert.doesNotMatch(deployStep, /--adopt/u);
		}
		assert.match(step("Deploy the relay (preview)"), /--target preview/u);
		assert.match(step("Deploy the relay (production)"), /--target production/u);
		stepBefore("Deploy the relay (preview)", "Deploy the relay (production)");
	});

	it("holds no Vercel token and deploys no Vercel command itself", () => {
		assert.doesNotMatch(
			workflow,
			/VERCEL_TOKEN|relay-deploy-credential|vercel deploy|--token\b/u,
		);
		assert.ok(
			!existsSync(join(root, "scripts/ci/relay-deploy-credential.mts")),
		);
	});

	it("reports a deploy refusal before preserving its nonzero exit status", () => {
		const work = mkdtempSync(join(tmpdir(), "relay-deploy-report-"));
		try {
			const bin = join(work, "packages/hobo/dist/bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(
				join(bin, "hobo.js"),
				'process.stdout.write(JSON.stringify({code:"HOBO_TEST_REFUSED",message:"deployment unavailable"})); process.exitCode = 27;',
			);
			const summary = join(work, "summary.md");
			const lines = step("Deploy the relay (preview)").split("\n");
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

	it("fits the deploy job in 20 minutes: the gate's deadline bounds both deploys, the step timeouts only back it up", () => {
		const deploy = /^ {2}deploy:\n([\s\S]*?)\n {4}steps:/mu.exec(workflow)?.[1];
		assert.ok(deploy, "no deploy job");
		const jobTimeout = Number(
			/^ {4}timeout-minutes: (\d+)$/mu.exec(deploy)?.[1],
		);
		assert.equal(jobTimeout, RELAY_DEPLOY_JOB_TIMEOUT_MINUTES);
		assert.ok(jobTimeout <= 20, "every job is capped at 20 minutes");
		assert.ok(RELAY_DEPLOY_JOB_MARGIN_MINUTES >= 2);
		// The deadline is counted from the gate's own run, the job's timeout
		// less the margin.
		assert.equal(
			deployDeadline(Date.UTC(2026, 10, 13, 12)),
			"2026-11-13T12:17:00.000Z",
		);
		for (const name of [
			"Deploy the relay (preview)",
			"Deploy the relay (production)",
		]) {
			const deployStep = step(name);
			assert.match(
				deployStep,
				/DEPLOY_DEADLINE: \$\{\{ steps\.gate\.outputs\.deadline \}\}/u,
			);
			assert.match(deployStep, /--deadline "\$DEPLOY_DEADLINE"/u);
			const stepTimeout = Number(
				/timeout-minutes: (\d+)/u.exec(deployStep)?.[1],
			);
			assert.ok(
				stepTimeout >= jobTimeout - RELAY_DEPLOY_JOB_MARGIN_MINUTES,
				`${name} step timeout ${stepTimeout} would cut the command short of its deadline`,
			);
		}
		const steps = workflow.slice(
			workflow.indexOf("    steps:", workflow.indexOf("\n  deploy:")),
			workflow.indexOf("\n  app-credentials:"),
		);
		for (const match of steps.matchAll(/timeout-minutes: (\d+)/gu))
			assert.ok(Number(match[1]) <= jobTimeout, match[0]);
		assert.match(workflow, /HOBO_CI_DEPLOY_NOT_QUALIFIED/u);
	});

	it("verifies at the Yard's production domain, needing no Deployment Protection bypass", () => {
		// The production origin comes from the committed Yard, not a variable,
		// and is an https origin with no path.
		const yardSource = readFileSync(
			join(root, "packages", "ci-vercel", "deploy", "yard.ts"),
			"utf8",
		);
		const origin = /productionOrigin: "(https:\/\/[^"/]+)"/u.exec(yardSource);
		assert.ok(origin, "deploy/yard.ts declares no productionOrigin");
		assert.match(
			yardSource,
			/productionOrigin: RELAY_PLACEMENT\.productionOrigin/u,
		);
		assert.match(workflow, /productionOrigin in deploy\/yard\.ts/u);
		assert.ok(origin[1], "deploy/yard.ts declares an empty productionOrigin");
		const originLiteral = origin[1].replaceAll(".", "\\.");
		assert.match(
			workflow,
			new RegExp(`HOBO_CI_RELAY_URL: ${originLiteral}`, "u"),
		);
		// Nothing in the workflow reaches past protection or names a probe URL.
		assert.doesNotMatch(
			workflow,
			/protection-bypass|VERCEL_AUTOMATION_BYPASS_SECRET|x-vercel-set-bypass-cookie/iu,
		);
		for (const name of [
			"Deploy the relay (preview)",
			"Deploy the relay (production)",
		]) {
			const deployStep = step(name);
			assert.doesNotMatch(deployStep, /https?:\/\//u, deployStep);
		}
	});

	it("verifies the secret store's CI identity by name before deploying", () => {
		const verify = step("Verify the secret store connection");
		assert.match(
			verify,
			/node packages\/hobo\/dist\/bin\/hobo\.js ci secret-store verify/u,
		);
		assert.match(verify, /relay-deploy-secret-store-verify-report\.mts/u);
		assert.doesNotMatch(verify, /\|\| true/u);
		stepBefore(
			"Verify the secret store connection",
			"Deploy the relay (preview)",
		);
	});

	it("uses the Vercel CLI pinned by the repository's frozen lockfile", () => {
		assert.doesNotMatch(workflow, /pnpm --dir|\badd vercel@/u);
		assert.match(workflow, /pnpm install --frozen-lockfile/u);
		assert.match(
			workflow,
			/HOBO_VERCEL_CLI: \$\{\{ github\.workspace \}\}\/packages\/ci-vercel\/node_modules\/\.bin\/vercel/u,
		);
		const manifest = readFileSync(
			join(root, "packages", "ci-vercel", "package.json"),
			"utf8",
		);
		assert.match(manifest, /"vercel": "65\.2\.0"/u);
		assert.match(lockfile, /vercel:\n\s+specifier: 65\.2\.0/u);
		assert.match(
			lockfile,
			/vercel@65\.2\.0[^\n]*:\n\s+resolution: \{integrity:/u,
		);
	});

	it("fails the job on a relay that does not serve the deployed commit, without masking anything", () => {
		const verify = step("Verify the relay at its production origin");
		assert.match(verify, /set -euo pipefail/u);
		assert.match(verify, /scripts\/ci\/relay-deploy-verify\.mts/u);
		assert.match(verify, /--origin "\$HOBO_CI_RELAY_URL"/u);
		assert.match(verify, /--sha "\$GITHUB_SHA"/u);
		assert.doesNotMatch(verify, /\|\| true/u);
		assert.match(verify, /if: steps\.gate\.outputs\.run == 'true'/u);
		stepBefore(
			"Deploy the relay (production)",
			"Verify the relay at its production origin",
		);
		stepBefore(
			"Verify the relay at its production origin",
			"Probe the fleet verdict at the public origin",
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

		it("runs after the deploy and its verification, so it reports on what this workflow shipped", () => {
			stepBefore("Verify the relay at its production origin", name);
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
