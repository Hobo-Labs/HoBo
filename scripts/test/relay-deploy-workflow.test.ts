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
import { verifyEnvironmentProtection } from "../ci/relay-deploy-environment.mts";
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
const appCredentialsWorkflow = readFileSync(
	join(root, ".github", "workflows", "app-credentials.yml"),
	"utf8",
);
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

	it("fails an absent or unreadable store closed", () => {
		const missing = decide({
			event: "push",
			store: "absent",
			changed: ["packages/ci-vercel/src/entry.ts"],
			inputDirs,
		});
		assert.equal(missing.run, false);
		assert.equal(missing.fatal, true);
		assert.ok(missing.reason.includes(RELAY_SECRET_STORE_BINDING));
		assert.match(missing.reason, /hobo ci secret-store provision/u);
		const broken = decide({
			event: "workflow_dispatch",
			store: "unreadable",
			inputDirs,
		});
		assert.equal(broken.run, false);
		assert.equal(broken.fatal, true);
	});

	it("admits only a complete HTTPS binding with an exact protected writer subject", () => {
		assert.equal(storeBindingState(undefined), "absent");
		assert.equal(storeBindingState("not json"), "unreadable");
		assert.equal(
			storeBindingState(
				JSON.stringify({ kind: "infisical-self-hosted", endpoint: "http://x" }),
			),
			"unreadable",
		);
		const complete = {
			kind: "infisical-self-hosted",
			endpoint: "https://secrets.example",
			projectId: "proj-runtime",
			deployProjectId: "proj-deploy",
			relayIdentityId: "relay-identity",
			deployIdentityId: "deploy-identity",
			deployCredentialIdentityId: "deploy-credential-identity",
			deployOidcSubject:
				"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
		};
		assert.equal(storeBindingState(JSON.stringify(complete)), "bound");
		for (const deployOidcSubject of [
			"repo:untrusted@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
			"repo:Hobo-Labs@344805935/untrusted@1274791462:environment:hobo-ci-app-credentials",
			"repo:Hobo-Labs@1/HoBo@1274791462:environment:hobo-ci-app-credentials",
			"repo:Hobo-Labs@344805935/HoBo@1:environment:hobo-ci-app-credentials",
			"repo:Hobo-Labs/HoBo:environment:hobo-ci-app-credentials",
			"repo:Hobo-Labs@*/HoBo@1274791462:environment:hobo-ci-app-credentials",
			"repo:Hobo-Labs@344805935/HoBo@*:environment:hobo-ci-app-credentials",
			"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:*",
			"prefix:repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
		])
			assert.equal(
				storeBindingState(JSON.stringify({ ...complete, deployOidcSubject })),
				"unreadable",
			);
	});

	it("skips deployment explicitly for the committed credential-free binding without treating corruption as a skip", () => {
		const legacy = JSON.stringify({
			kind: "infisical-cloud-attach",
			endpoint: "https://app.infisical.com",
			projectId: "proj-runtime",
			environment: "prod",
			secretPath: "/hobo-ci-relay",
			relayIdentityId: "relay-identity",
			deployIdentityId: "deploy-identity",
			vercelTeamId: "team_BRBUnG6uGhSsVV3EG5GFV3FM",
			claimBundleId: "secret-store:hobo-ci-relay:connect-1",
			claimState: "claimed",
		});
		assert.equal(storeBindingState(legacy), "unconfigured");
		const committed = readFileSync(
			join(root, RELAY_SECRET_STORE_BINDING),
			"utf8",
		);
		assert.equal(storeBindingState(committed), "unconfigured");
		const skipped = decide({
			event: "push",
			store: storeBindingState(legacy),
			changed: [RELAY_SECRET_STORE_BINDING],
			inputDirs,
		});
		assert.equal(skipped.run, false);
		assert.equal(skipped.fatal, undefined);
		assert.match(skipped.reason, /production observation.*required/u);
		for (const halfConfigured of [
			{ ...JSON.parse(legacy), deployProjectId: "proj-deploy" },
			{ ...JSON.parse(legacy), deployCredentialIdentityId: "reader" },
			{
				...JSON.parse(legacy),
				deployOidcSubject:
					"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:untrusted",
			},
		])
			assert.equal(
				storeBindingState(JSON.stringify(halfConfigured)),
				"unreadable",
			);
		assert.equal(
			storeBindingState(
				JSON.stringify({
					...JSON.parse(legacy),
					deployOidcSubject:
						"repo:Hobo-Labs@344805935/HoBo@1274791462:environment:hobo-ci-app-credentials",
				}),
			),
			"unconfigured",
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

describe("relay GitHub environment protection", () => {
	const protectedEnvironment = {
		deployment_branch_policy: {
			protected_branches: false,
			custom_branch_policies: true,
		},
	};
	const mainOnly = { branch_policies: [{ name: "main", type: "branch" }] };
	type EnvironmentFixture = {
		deployment_branch_policy: {
			protected_branches: boolean;
			custom_branch_policies: boolean;
		} | null;
	};
	type BranchFixture = {
		branch_policies: { name: string; type: string }[];
	};

	function github(
		environment: EnvironmentFixture | null = protectedEnvironment,
		branches: BranchFixture = mainOnly,
	) {
		const paths: string[] = [];
		const authorizations: (string | null)[] = [];
		const send: typeof fetch = async (request, init) => {
			const url = new URL(String(request));
			paths.push(url.pathname);
			authorizations.push(new Headers(init?.headers).get("authorization"));
			if (environment === null) return Response.json({}, { status: 404 });
			return Response.json(
				url.pathname.endsWith("/deployment-branch-policies")
					? branches
					: environment,
			);
		};
		return { send, paths, authorizations };
	}

	it("requires an exact main-only deployment branch policy", async () => {
		const fake = github();
		const result = await verifyEnvironmentProtection(
			"hobo-ci-deploy",
			fake.send,
		);
		assert.equal(result.ok, true, result.detail);
		assert.deepEqual(fake.paths, [
			"/repos/Hobo-Labs/HoBo/environments/hobo-ci-deploy",
			"/repos/Hobo-Labs/HoBo/environments/hobo-ci-deploy/deployment-branch-policies",
		]);
		assert.deepEqual(fake.authorizations, [null, null]);
	});

	it("uses a scoped GitHub token for both reads when supplied", async () => {
		const fake = github();
		const result = await verifyEnvironmentProtection(
			"hobo-ci-app-credentials",
			fake.send,
			"scoped-token",
		);
		assert.equal(result.ok, true, result.detail);
		assert.deepEqual(fake.authorizations, [
			"Bearer scoped-token",
			"Bearer scoped-token",
		]);
	});

	it("fails closed on absent, unprotected, malformed, and unreachable environments", async () => {
		for (const fake of [
			github(null),
			github({ ...protectedEnvironment, deployment_branch_policy: null }),
			github(protectedEnvironment, {
				branch_policies: [{ name: "release", type: "branch" }],
			}),
			github(protectedEnvironment, {
				branch_policies: [
					{ name: "main", type: "branch" },
					{ name: "release", type: "branch" },
				],
			}),
			github(protectedEnvironment, {
				branch_policies: [{ name: "main", type: "tag" }],
			}),
			github(protectedEnvironment, { branch_policies: [] }),
		]) {
			const result = await verifyEnvironmentProtection(
				"hobo-ci-app-credentials",
				fake.send,
			);
			assert.equal(result.ok, false, result.detail);
		}
		const unavailable = await verifyEnvironmentProtection(
			"hobo-ci-deploy",
			async () => {
				throw new Error("offline");
			},
		);
		assert.equal(unavailable.ok, false);
		assert.equal(
			(await verifyEnvironmentProtection("other", github(null).send)).ok,
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
		assert.deepEqual(inputs, ["force_bootstrap", "relay", "owner_id"]);
		assert.match(workflow, / {2}workflow_call:\n {4}inputs:/u);
		assert.match(
			workflow,
			/ {4}secrets:\n {6}manifest_code:\n {8}required: true/u,
		);
		const bootstrap =
			/^ {6}force_bootstrap:\n {8}description:[^\n]*\n {8}required: false\n {8}default: false\n {8}type: boolean/mu;
		assert.match(workflow, bootstrap);
		assert.match(
			workflow,
			/if: github\.repository == 'Hobo-Labs\/HoBo' && github\.ref == 'refs\/heads\/main'/u,
		);
		assert.match(workflow, /cancel-in-progress: false/u);
	});

	it("runs the gate without environment protection or OIDC and admits only approved deploys to the protected job", () => {
		const gate = /^ {2}gate:\n([\s\S]*?)(?=\n {2}deploy:)/mu.exec(
			workflow,
		)?.[1];
		assert.ok(gate, "no gate job");
		assert.doesNotMatch(gate, /environment:|id-token:/u);
		assert.match(
			gate,
			/outputs:\n {6}run: \$\{\{ steps\.gate\.outputs\.run \}\}/u,
		);
		const deploy = /^ {2}deploy:\n([\s\S]*?)\n {4}steps:/mu.exec(workflow)?.[1];
		assert.ok(deploy, "no deploy job");
		assert.match(deploy, /needs: \[route, gate, deploy-build\]/u);
		assert.match(deploy, /environment: hobo-ci-deploy/u);
		assert.match(
			deploy,
			/^ {4}if: github\.repository == 'Hobo-Labs\/HoBo' && github\.ref == 'refs\/heads\/main' && github\.event_name != 'workflow_call' && needs\.gate\.outputs\.run == 'true'$/mu,
		);
		assert.doesNotMatch(deploy, /id: gate/u);
	});

	it("passes force_bootstrap to the gate as FORCE_BOOTSTRAP, and only there", () => {
		const gate = step("Evaluate the relay inputs");
		assert.match(gate, /id: gate/u);
		assert.match(gate, /relay-deploy-gate\.mts/u);
		assert.match(
			gate,
			/FORCE_BOOTSTRAP: \$\{\{ github\.event\.inputs\.force_bootstrap \}\}/u,
		);
	});

	it("may read the repository, mint deploy OIDC tokens, and authenticate only environment reads", () => {
		assert.match(workflow, /^permissions:\n {2}contents: read\n/mu);
		assert.match(
			workflow,
			/ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/u,
		);
		assert.doesNotMatch(workflow, /deployments:/u);
		for (const name of [
			"Verify the protected deploy environment",
			"Verify the protected writer environment",
		])
			assert.match(step(name), /GITHUB_TOKEN: \$\{\{ github\.token \}\}/u);
		assert.equal(workflow.match(/GITHUB_TOKEN:/gu)?.length, 2);
		assert.deepEqual(workflow.match(/\$\{\{ secrets\.[a-z_]+ \}\}/gu), [
			"${{ secrets.manifest_code }}",
			"${{ secrets.manifest_code }}",
		]);
		assert.doesNotMatch(workflow, /write-all/u);
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

	it("reports deploy results through the redacting, fail-closed envelope report", () => {
		const script = "scripts/ci/relay-deploy-result-report.mts";
		assert.ok(existsSync(join(root, script)), `${script} is missing`);
		for (const name of [
			"Deploy the relay (preview)",
			"Deploy the relay (production)",
			"Convert the manifest code and store the credentials (GitHub OIDC)",
		]) {
			const run = step(name);
			assert.match(run, /relay-deploy-result-report\.mts/u, name);
			assert.doesNotMatch(
				run,
				/node -e 'const r = JSON\.parse/u,
				`${name} still prints the raw envelope inline`,
			);
		}
		const dir = mkdtempSync(join(tmpdir(), "hobo-relay-result-report-"));
		try {
			const json = join(dir, "result.json");
			const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
			writeFileSync(
				json,
				JSON.stringify({
					ok: false,
					code: "HOBO_FAIL",
					message: `token ${secret}`,
				}),
			);
			const redacted = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					join(root, script),
					json,
					"Deploy the relay (preview)",
					"",
					"1",
				],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(redacted.status, 1);
			assert.match(redacted.stdout, /\[redacted\]/u);
			assert.doesNotMatch(redacted.stdout, /ghp_/u);

			const missing = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					join(root, script),
					join(dir, "missing.json"),
					"Deploy the relay (preview)",
					"",
					"1",
				],
				{ cwd: root, encoding: "utf8" },
			);
			assert.equal(missing.status, 1);
			assert.match(
				missing.stdout,
				/command did not emit a valid JSON envelope/u,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("builds the CLI unprivileged and runs only its digest-pinned artifact", () => {
		const build = workflow
			.split("\n  deploy-build:\n")[1]
			?.split("\n  deploy:\n")[0];
		assert.ok(build, "no deploy-build job");
		assert.match(build, /^ {4}permissions:\n {6}contents: read$/mu);
		assert.doesNotMatch(build, /id-token/u);
		assert.match(build, /turbo run build/u);
		assert.match(build, /release-freight-cli\.mts pack/u);
		assert.match(
			build,
			/--include scripts\/ci\/relay-deploy-result-report\.mts/u,
		);
		assert.match(
			build,
			/actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/u,
		);
		const deploy = workflow
			.split("\n  deploy:\n")[1]
			?.split("\n  app-credentials:\n")[0];
		assert.ok(deploy, "no deploy job");
		assert.match(deploy, /needs: \[route, gate, deploy-build\]/u);
		assert.match(deploy, /id-token: write/u);
		assert.doesNotMatch(deploy, /turbo run build/u);
		assert.match(
			deploy,
			/actions\/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333/u,
		);
		assert.match(deploy, /bootstrap-restore/u);
		assert.match(deploy, /HOBO_RELAY_CLI_DIGEST/u);
		assert.doesNotMatch(deploy, /release-freight-cli\.mts restore/u);
		const restoreAt = deploy.indexOf("bootstrap-restore");
		assert.ok(restoreAt > 0, "no digest-pinned restore");
		assert.ok(
			restoreAt < deploy.indexOf("ci secret-store verify"),
			"the restore must precede every command that runs the CLI",
		);
		assert.ok(restoreAt < deploy.indexOf("ci deploy"));
		const deposit = workflow.split("\n  app-credentials:\n")[1];
		assert.ok(deposit, "no app-credentials job");
		assert.match(deposit, /needs: \[route, deploy-build\]/u);
		assert.doesNotMatch(deposit, /turbo run build/u);
		assert.match(deposit, /bootstrap-restore/u);
		assert.doesNotMatch(deposit, /release-freight-cli\.mts restore/u);
		assert.match(deposit, /HOBO_RELAY_CLI_DIGEST/u);
		assert.ok(
			deposit.indexOf("bootstrap-restore") < deposit.indexOf("ci app deposit"),
		);
	});

	it("restores the CLI only against the build job's own digest output", () => {
		const deploy = workflow
			.split("\n  deploy:\n")[1]
			?.split("\n  app-credentials:\n")[0];
		const deposit = workflow.split("\n  app-credentials:\n")[1];
		assert.ok(deploy && deposit);
		for (const job of [deploy, deposit]) {
			assert.match(
				job,
				/HOBO_RELAY_CLI_DIGEST: \$\{\{ needs\.deploy-build\.outputs\.digest \}\}/u,
			);
			assert.doesNotMatch(
				job,
				/HOBO_RELAY_CLI_DIGEST: \$\{\{ (github\.event|env|vars)\./u,
			);
		}
		assert.match(workflow, /digest: \$\{\{ steps\.pack\.outputs\.digest \}\}/u);
	});

	it("requires the GitHub OIDC mint before any deploy command", () => {
		const required = step("Require the GitHub OIDC mint");
		assert.match(required, /ACTIONS_ID_TOKEN_REQUEST_URL/u);
		assert.match(required, /ACTIONS_ID_TOKEN_REQUEST_TOKEN/u);
		assert.doesNotMatch(required, /\|\| true/u);
		stepBefore("Require the GitHub OIDC mint", "Deploy the relay (preview)");
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

	it("never adopts and never waits for a Git-linked deployment: HoBo builds once and promotes", () => {
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
			assert.match(deployStep, /--build prebuilt --provision --wait/u);
			assert.match(deployStep, /--deadline "\$DEPLOY_DEADLINE"/u);
			assert.match(deployStep, /relay-deploy-result-report\.mts/u);
			assert.match(deployStep, /"\$status"/u);
			assert.doesNotMatch(deployStep, /--adopt/u);
		}
		assert.match(step("Deploy the relay (preview)"), /--target preview/u);
		assert.match(step("Deploy the relay (production)"), /--target production/u);
		stepBefore("Deploy the relay (preview)", "Deploy the relay (production)");
	});

	it("holds no Vercel token and deploys no Vercel command itself", () => {
		const actionable = workflow
			.split("\n")
			.filter((line) => !/^\s*#/u.test(line))
			.join("\n");
		assert.doesNotMatch(
			actionable,
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
			const scripts = join(work, "scripts/ci");
			mkdirSync(scripts, { recursive: true });
			for (const file of [
				"relay-deploy-result-report.mts",
				"relay-deploy-redaction.mts",
			])
				writeFileSync(
					join(scripts, file),
					readFileSync(join(root, "scripts/ci", file)),
				);
			const redactionDist = join(work, "packages/provider-redaction/dist");
			mkdirSync(redactionDist, { recursive: true });
			writeFileSync(
				join(redactionDist, "provider-redaction.js"),
				[
					"export const GLUED_BEARER_PATTERN = /Bearer\\s+[A-Za-z0-9._~+/=%-]+/gu;",
					"export const LONG_TOKEN_RUN_PROFILE = { patterns: [] };",
					"export function createProviderRedactor() {",
					"  return (text, maxLength = 256) => {",
					"    const redacted = String(text)",
					'      .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[redacted]")',
					'      .replace(/Bearer\\s+[A-Za-z0-9._~+/=%-]+/g, "Bearer [redacted]");',
					'    return redacted.length > maxLength ? redacted.slice(0, maxLength) + "...[cut]" : redacted;',
					"  };",
					"}",
					"export function redactProviderText(text, maxLength = 256) {",
					"  return createProviderRedactor()(text, maxLength);",
					"}",
					"",
				].join("\n"),
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

	it("fits the deploy job in 20 minutes: its admitted-job deadline bounds both deploys, the step timeouts only back it up", () => {
		const deploy = /^ {2}deploy:\n([\s\S]*?)\n {4}steps:/mu.exec(workflow)?.[1];
		assert.ok(deploy, "no deploy job");
		const jobTimeout = Number(
			/^ {4}timeout-minutes: (\d+)$/mu.exec(deploy)?.[1],
		);
		assert.equal(jobTimeout, RELAY_DEPLOY_JOB_TIMEOUT_MINUTES);
		assert.ok(jobTimeout <= 20, "every job is capped at 20 minutes");
		assert.ok(RELAY_DEPLOY_JOB_MARGIN_MINUTES >= 2);
		assert.match(step("Start the deploy deadline"), /id: deadline/u);
		assert.match(step("Start the deploy deadline"), /17\s*\*\s*60_000/u);
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
				/DEPLOY_DEADLINE: \$\{\{ steps\.deadline\.outputs\.deadline \}\}/u,
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
		const deployJob = /^ {2}deploy:\n([\s\S]*?)\n {4}steps:/mu.exec(
			workflow,
		)?.[1];
		assert.ok(deployJob, "no deploy job");
		assert.match(
			deployJob,
			/HOBO_CI_RELAY_PUBLIC_URL: https:\/\/hobo-ci\.vercel\.app/u,
		);
		assert.match(deployJob, /HOBO_CI_RELAY_STAGED_PRODUCTION: "true"/u);
		assert.match(deployJob, /HOBO_CI_RELAY_PREVIEW_PROBE_OIDC: "true"/u);
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

	it("verifies only the reader in the deploy environment before deploying", () => {
		const verify = step("Verify the secret store connection");
		assert.match(
			verify,
			/node packages\/hobo\/dist\/bin\/hobo\.js ci secret-store verify/u,
		);
		assert.match(verify, /--identity reader/u);
		assert.match(verify, /relay-deploy-secret-store-verify-report\.mts/u);
		assert.doesNotMatch(verify, /\|\| true/u);
		stepBefore(
			"Verify the secret store connection",
			"Deploy the relay (preview)",
		);
	});

	it("verifies actual protection and matching identity scopes in both environments", () => {
		assert.match(
			workflow,
			/\n  deploy:\n(?:.*\n)*?    environment: hobo-ci-deploy\n/u,
		);
		assert.match(
			workflow,
			/\n  app-credentials:\n(?:.*\n)*?    environment: hobo-ci-app-credentials\n/u,
		);
		const readerEnvironment = step("Verify the protected deploy environment");
		assert.match(readerEnvironment, /relay-deploy-environment\.mts/u);
		assert.match(readerEnvironment, /--environment hobo-ci-deploy/u);
		stepBefore(
			"Start the deploy deadline",
			"Verify the protected deploy environment",
		);
		stepBefore(
			"Verify the protected deploy environment",
			"Verify the secret store connection",
		);
		const writerEnvironment = step("Verify the protected writer environment");
		assert.match(writerEnvironment, /--environment hobo-ci-app-credentials/u);
		for (const environment of [readerEnvironment, writerEnvironment])
			assert.doesNotMatch(environment, /\|\| true|continue-on-error:\s*true/u);
		const writer = step("Verify the writer connection");
		assert.match(writer, /--identity writer/u);
		stepBefore(
			"Restore the built hobo CLI (inline bootstrap, no repo code)",
			"Verify the writer connection",
		);
		stepBefore(
			"Verify the writer connection",
			"Convert the manifest code and store the credentials (GitHub OIDC)",
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
		assert.match(verify, /if: needs\.gate\.outputs\.run == 'true'/u);
		stepBefore(
			"Deploy the relay (production)",
			"Verify the relay at its production origin",
		);
		stepBefore(
			"Verify the relay at its production origin",
			"Probe the fleet verdict at the public origin",
		);
	});

	it("deposits the GitHub App's credentials from a required reusable-workflow secret, masked first", () => {
		assert.match(
			workflow,
			/ {2}app-credentials:\n[\s\S]*?if: [^\n]*github\.event_name == 'workflow_call'$/mu,
		);
		assert.match(
			workflow,
			/ {2}deploy:\n[\s\S]*?if: [^\n]*github\.event_name != 'workflow_call'/u,
		);
		assert.match(appCredentialsWorkflow, /^on:\n {2}workflow_dispatch:/mu);
		assert.match(
			appCredentialsWorkflow,
			/uses: \.\/\.github\/workflows\/relay-deploy\.yml/u,
		);
		for (const input of ["relay", "owner_id"])
			assert.match(
				appCredentialsWorkflow,
				new RegExp(`${input}: \\$\\{\\{ inputs\\.${input} \\}\\}`, "u"),
			);
		assert.match(
			appCredentialsWorkflow,
			/ {4}secrets:\n {6}manifest_code: \$\{\{ secrets\.HOBO_APP_MANIFEST_CODE \}\}/u,
		);
		assert.equal(appCredentialsWorkflow.match(/\$\{\{ secrets\./gu)?.length, 1);
		assert.doesNotMatch(
			`${workflow}\n${appCredentialsWorkflow}`,
			/github\.event\.inputs\.manifest_code|inputs\.manifest_code/u,
		);
		const mask = step("Mask the one-time manifest code");
		assert.match(
			mask,
			/HOBO_APP_MANIFEST_CODE: \$\{\{ secrets\.manifest_code \}\}/u,
		);
		assert.match(mask, /\[ -z "\$HOBO_APP_MANIFEST_CODE" \]/u);
		assert.match(mask, /exit 1/u);
		assert.match(mask, /::add-mask::\$HOBO_APP_MANIFEST_CODE/u);
		const deposit = step(
			"Convert the manifest code and store the credentials (GitHub OIDC)",
		);
		assert.match(deposit, /ci app deposit/u);
		assert.match(
			deposit,
			/HOBO_APP_MANIFEST_CODE: \$\{\{ secrets\.manifest_code \}\}/u,
		);
		assert.doesNotMatch(deposit, /--code/u);
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
			assert.match(probe, /if: needs\.gate\.outputs\.run == 'true'/u);
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
