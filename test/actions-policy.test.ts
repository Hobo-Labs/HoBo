import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished, test } from "vitest";

const policy = fileURLToPath(
	new URL("../scripts/lint-actions.ts", import.meta.url),
);
const template = await readFile(
	new URL(
		"../packages/ci-gh-actions/templates/hobo-ci-smoke.yml",
		import.meta.url,
	),
	"utf8",
);
const enabled = "hobo-ci-acceptance.yml";

async function fixture(workflows: Record<string, string> = {}) {
	const root = await mkdtemp(join(tmpdir(), "hobo-actions-policy-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".github/workflows"), { recursive: true });
	for (const [name, text] of Object.entries(workflows))
		await writeFile(join(root, ".github/workflows", name), text);
	return root;
}
function lint(root: string) {
	return spawnSync(process.execPath, ["--experimental-strip-types", policy], {
		cwd: root,
		encoding: "utf8",
	});
}

test("only the reviewed manual HoBo acceptance recipe is enabled", async () => {
	const actual = await readFile(
		new URL("../.github/workflows/hobo-ci-acceptance.yml", import.meta.url),
		"utf8",
	);
	assert.equal(
		actual,
		template,
		"the installable smoke template matches HoBo's actual acceptance job",
	);
	const result = lint(await fixture({ [enabled]: actual }));
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /1 enabled workflow/);
});
test("authoritative CI workflows are an allowed enabled set", async () => {
	const minimalHoboCi = `name: HoBo CI Fabric
on:
  push:
    branches: [main]
jobs:
  pr-gate:
    runs-on: hobo
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version: "24"
`;
	const result = lint(
		await fixture({
			[enabled]: template,
			"hobo-ci.yml": minimalHoboCi,
		}),
	);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /2 enabled workflow/);
});
test("a checkout without enabled workflows still passes", async () => {
	assert.equal(lint(await fixture()).status, 0);
});
test("every other recognized workflow filename remains forbidden", async () => {
	for (const name of ["ci.yml", "hobo-ci-acceptance.yaml", "CI.YML"]) {
		const result = lint(
			await fixture({ [enabled]: template, [name]: template }),
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /approved CI fabric set/);
	}
});
for (const [name, original, changed] of [
	["hosted runner fallback", "runs-on: hobo", "runs-on: ubuntu-latest"],
	["dynamic runner override", "runs-on: hobo", "runs-on: ${{ vars.RUNNER }}"],
	["automatic events", "  workflow_dispatch:", "  push:"],
	[
		"extra automatic event",
		"  workflow_dispatch:",
		"  workflow_dispatch:\n  pull_request:",
	],
	["write permissions", "  contents: read", "  contents: write"],
	[
		"OIDC permission",
		"  contents: read",
		"  contents: read\n  id-token: write",
	],
	[
		"disabled job",
		"    runs-on: hobo",
		"    if: ${{ false }}\n    runs-on: hobo",
	],
	["unbounded timeout", "    timeout-minutes: 10\n", ""],
	[
		"floating action",
		"actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
		"actions/checkout@v4",
	],
	[
		"extra job",
		"jobs:\n",
		"jobs:\n  hosted:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
	],
] as const) {
	test(`the approved filename cannot enable ${name}`, async () => {
		assert.ok(template.includes(original));
		const result = lint(
			await fixture({ [enabled]: template.replace(original, changed) }),
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /differs from its reviewed recipe/);
	});
}
test("the preserved CI job-disable policy remains enforced", async () => {
	const root = await fixture({ [enabled]: template });
	await mkdir(join(root, ".github/workflows-disabled"));
	const path = join(root, ".github/workflows-disabled/ci.yml");
	await writeFile(
		path,
		"jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
	);
	assert.equal(lint(root).status, 1);
	await writeFile(
		path,
		"jobs:\n  build:\n    if: ${{ false }}\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
	);
	assert.equal(lint(root).status, 0);
});

test("the optional JIT smoke verifies runner identity without the full workflow steps", () => {
	assert.match(
		template,
		/jit_only:\n\s+description:[^\n]+\n\s+required: false\n\s+type: boolean\n\s+default: false/,
	);
	assert.equal(
		(template.match(/if: \$\{\{ !inputs\.jit_only \}\}/g) ?? []).length,
		4,
	);
	const match = template.match(
		/      - name: Verify HoBo JIT runner\n[\s\S]+?        run: \|\n([\s\S]+?)      - uses: actions\/checkout@/,
	);
	assert.ok(match?.[1]);
	const script = match[1]
		.split("\n")
		.map((line) => line.slice(10))
		.join("\n");
	const env = {
		PATH: process.env.PATH,
		RUNNER_NAME: "hobo-12345678-1234-4234-8234-123456789abc",
		RUNNER_ENVIRONMENT: "self-hosted",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_RUN_ID: "100",
		GITHUB_RUN_ATTEMPT: "1",
	};
	const run = (runnerEnvironment: string) =>
		spawnSync("bash", ["-c", script], {
			env: { ...env, RUNNER_ENVIRONMENT: runnerEnvironment },
			encoding: "utf8",
		});
	const success = run("self-hosted");
	assert.equal(success.status, 0, success.stderr);
	assert.match(success.stdout, /hobo-jit-smoke run=100 attempt=1 runner=hobo-/);
	assert.notEqual(run("github-hosted").status, 0);
});

async function smokeFixture() {
	const root = await fixture();
	const isolatedEnv = { PATH: process.env.PATH };
	for (const args of [
		["init", "--quiet"],
		[
			"-c",
			"user.name=HoBo Test",
			"-c",
			"user.email=test@example.test",
			"-c",
			"core.hooksPath=/dev/null",
			"commit",
			"--quiet",
			"--allow-empty",
			"-m",
			"smoke fixture",
		],
	]) {
		const result = spawnSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: isolatedEnv,
		});
		assert.equal(result.status, 0, result.stderr);
	}
	const revision = spawnSync("git", ["rev-parse", "HEAD"], {
		cwd: root,
		encoding: "utf8",
		env: isolatedEnv,
	});
	assert.equal(revision.status, 0, revision.stderr);
	const sha = revision.stdout.trim();
	const match = template.match(
		/          node --input-type=module <<'NODE'\n([\s\S]+?)          NODE/,
	);
	assert.ok(
		match,
		"the reviewed recipe contains its native Node evidence check",
	);
	const source = match[1];
	assert.ok(source);
	const script = source
		.split("\n")
		.map((line) => line.slice(10))
		.join("\n");
	const env = {
		...isolatedEnv,
		RUNNER_NAME: "hobo-12345678-1234-4234-8234-123456789abc",
		RUNNER_ENVIRONMENT: "self-hosted",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REPOSITORY: "hobo/test",
		EXPECTED_REPOSITORY: "hobo/test",
		GITHUB_REF: "refs/heads/smoke",
		EXPECTED_REF: "refs/heads/smoke",
		GITHUB_SHA: sha,
		EXPECTED_SHA: sha,
		GITHUB_RUN_ID: "100",
		GITHUB_RUN_ATTEMPT: "1",
	};
	return { root, env, script, sha };
}

test("the smoke check records native identity and real checked-out revision without claiming routing attestation", async () => {
	const h = await smokeFixture();
	const result = spawnSync(process.execPath, ["--input-type=module"], {
		cwd: h.root,
		env: h.env,
		input: h.script,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(
		JSON.parse(await readFile(join(h.root, "hobo-ci-acceptance.json"), "utf8")),
		{
			schemaVersion: 1,
			repository: "hobo/test",
			ref: "refs/heads/smoke",
			sha: h.sha,
			runId: "100",
			runAttempt: "1",
			runnerName: h.env.RUNNER_NAME,
			runnerEnvironment: "self-hosted",
			routingAttestation: false,
		},
	);
});
for (const [name, override] of [
	["hosted runner", { RUNNER_ENVIRONMENT: "github-hosted" }],
	["unrecognized runner name", { RUNNER_NAME: "GitHub Actions 1" }],
	[
		"wrong checkout",
		{ EXPECTED_SHA: "0".repeat(40), GITHUB_SHA: "0".repeat(40) },
	],
	["wrong repository", { GITHUB_REPOSITORY: "someone/else" }],
	["wrong event", { GITHUB_EVENT_NAME: "push" }],
] as const) {
	test(`the smoke check rejects ${name}`, async () => {
		const h = await smokeFixture();
		const result = spawnSync(process.execPath, ["--input-type=module"], {
			cwd: h.root,
			env: { ...h.env, ...override },
			input: h.script,
			encoding: "utf8",
		});
		assert.notEqual(result.status, 0);
		await assert.rejects(readFile(join(h.root, "hobo-ci-acceptance.json")));
	});
}
