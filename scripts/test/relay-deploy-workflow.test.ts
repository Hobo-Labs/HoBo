import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { verifyEnvironmentProtection } from "../ci/relay-deploy-environment.mts";
import { relayInputDirs, touchesRelay } from "../ci/relay-inputs.mts";
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

describe("the relay's inputs", () => {
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
	});

	it("recognises a change to the relay or a package it uses, and only that", () => {
		assert.equal(
			touchesRelay(["packages/ci-vercel/deploy/yard.ts"], inputDirs),
			true,
		);
		assert.equal(touchesRelay(["packages/core/src/index.ts"], inputDirs), true);
		assert.equal(
			touchesRelay([".github/workflows/relay-deploy.yml"], inputDirs),
			false,
		);
		assert.equal(
			touchesRelay(["docs/design/index.md", "site/src/x.ts"], inputDirs),
			false,
		);
		assert.equal(
			touchesRelay(["packages/ci-vercel-other/x.ts"], inputDirs),
			false,
		);
	});

	it("commits no store binding", () => {
		assert.equal(
			existsSync(
				join(
					root,
					"packages",
					"ci-vercel",
					"deploy",
					"secret-store.binding.json",
				),
			),
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
	it("never deploys the relay: no push or manual trigger, only the reusable app-credentials call", () => {
		assert.match(workflow, /^on:\n {2}workflow_call:\n {4}inputs:\n/mu);
		assert.doesNotMatch(workflow, /^ {2}(push|workflow_dispatch|schedule):/mu);
		const inputs = [
			...workflow.matchAll(/^ {6}([a-z_]+):\n {8}description:/gmu),
		].map((match) => match[1]);
		assert.deepEqual(inputs, ["relay", "owner_id"]);
		assert.match(
			workflow,
			/ {4}secrets:\n {6}manifest_code:\n {8}required: true/u,
		);
		const jobs = [...workflow.matchAll(/^ {2}([a-z-]+):\n {4}name:/gmu)].map(
			(match) => match[1],
		);
		assert.deepEqual(jobs, ["route", "app-credentials"]);
		assert.doesNotMatch(
			workflow,
			/hobo\.js ci deploy|ci secret-store verify[^\n]*--identity reader|environment: hobo-ci-deploy\n|relay-deploy-gate|relay-deploy-verify/u,
		);
		assert.match(
			workflow,
			/if: github\.repository == 'Hobo-Labs\/HoBo' && github\.ref == 'refs\/heads\/main'/u,
		);
		assert.match(workflow, /cancel-in-progress: false/u);
	});

	it("may read the repository, mint the writer's OIDC token, and authenticate only the environment read", () => {
		assert.match(workflow, /^permissions:\n {2}contents: read\n/mu);
		assert.match(
			workflow,
			/ {4}permissions:\n {6}contents: read\n {6}id-token: write\n/u,
		);
		assert.doesNotMatch(workflow, /deployments:/u);
		assert.match(
			step("Verify the protected writer environment"),
			/GITHUB_TOKEN: \$\{\{ github\.token \}\}/u,
		);
		assert.equal(workflow.match(/GITHUB_TOKEN:/gu)?.length, 1);
		assert.deepEqual(workflow.match(/\$\{\{ secrets\.[a-z_]+ \}\}/gu), [
			"${{ secrets.manifest_code }}",
			"${{ secrets.manifest_code }}",
		]);
		assert.doesNotMatch(workflow, /write-all|VERCEL_TOKEN|HOBO_VERCEL_CLI/u);
	});

	it("reads no repository variable or secret for the relay's configuration", () => {
		for (const line of workflow.split("\n"))
			if (line.includes("vars."))
				assert.match(
					line,
					/vars\.HOBO_CI_(ROUTE|LOCAL_RUNNER|ROUTE_MAX_WAIT_SECONDS|ROUTE_MAX_QUEUED|TRUNK_RUNNER)\b/u,
					line,
				);
		assert.doesNotMatch(workflow, /INFISICAL_|VERCEL_TEAM_ID/u);
	});

	it("routes the app-credentials job like hobo-ci.yml, so a busy fleet does not hold it", () => {
		assert.match(workflow, /^ {2}route:\n/mu);
		assert.match(workflow, /uses: \$\/\.github\/actions\/route-runner/u);
		assert.match(workflow, / {4}needs: route\n/u);
		assert.match(
			workflow,
			/runs-on: \$\{\{ needs\.route\.result == 'success' && \(needs\.route\.outputs\.runner \|\| 'ubuntu-24\.04'\) \|\| 'ubuntu-24\.04' \}\}/u,
		);
	});

	it("verifies actual protection and the writer's identity scope before the deposit", () => {
		assert.match(
			workflow,
			/\n  app-credentials:\n(?:.*\n)*?    environment: hobo-ci-app-credentials\n/u,
		);
		const writerEnvironment = step("Verify the protected writer environment");
		assert.match(writerEnvironment, /relay-deploy-environment\.mts/u);
		assert.match(writerEnvironment, /--environment hobo-ci-app-credentials/u);
		assert.doesNotMatch(
			writerEnvironment,
			/\|\| true|continue-on-error:\s*true/u,
		);
		const writer = step("Verify the writer connection");
		assert.match(writer, /--identity writer/u);
		stepBefore("Build the deposit tool", "Verify the writer connection");
		stepBefore(
			"Verify the writer connection",
			"Convert the manifest code and store the credentials (GitHub OIDC)",
		);
	});

	it("deposits the GitHub App's credentials from a required reusable-workflow secret, masked first", () => {
		assert.match(
			workflow,
			/ {2}app-credentials:\n[\s\S]*?if: [^\n]*github\.event_name == 'workflow_call'$/mu,
		);
		assert.match(appCredentialsWorkflow, /^on:\n {2}workflow_dispatch:/mu);
		assert.match(
			appCredentialsWorkflow,
			/uses: \.\/\.github\/workflows\/relay-deploy\.yml/u,
		);
		const callerKeys = [
			...(
				/\n {2}app-credentials:\n((?: {4}.*\n|\n)*)/u.exec(
					appCredentialsWorkflow,
				)?.[1] ?? ""
			).matchAll(/^ {4}([\w-]+):/gmu),
		].map((match) => match[1]);
		assert.deepEqual(
			callerKeys.filter(
				(key) =>
					![
						"name",
						"uses",
						"with",
						"secrets",
						"needs",
						"if",
						"permissions",
						"strategy",
						"concurrency",
					].includes(key ?? ""),
			),
			[],
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
