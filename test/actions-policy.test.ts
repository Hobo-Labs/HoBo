import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
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
const repositoryAcceptance = await readFile(
	new URL("../.github/workflows/hobo-ci-acceptance.yml", import.meta.url),
	"utf8",
);

function repositoryBootstrapJob(text: string, job: string): string {
	const lines = text.split("\n");
	const start = lines.indexOf(`  ${job}:`);
	assert.notEqual(start, -1, `${job} exists`);
	const end = lines.findIndex(
		(line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:$/u.test(line),
	);
	return lines.slice(start, end === -1 ? lines.length : end).join("\n");
}

function assertRepositoryBootstrapBoundary(text: string): void {
	const eventHeader = text.slice(
		text.indexOf("\non:\n"),
		text.indexOf("\npermissions:\n"),
	);
	assert.deepEqual(
		Array.from(eventHeader.matchAll(/^  ([a-z_]+):$/gmu), (match) => match[1]),
		["workflow_dispatch"],
		"operator bootstrap has no automatic event",
	);
	assert.deepEqual(
		Array.from(
			eventHeader.matchAll(/^      ([a-z_]+):$/gmu),
			(match) => match[1],
		),
		[
			"role",
			"lease_id",
			"image_ref",
			"control_branch",
			"signing_public_key",
			"lifetime_ms",
			"timeout_minutes",
			"jit_only",
			"dagger_acceptance",
			"dagger_bin",
		],
		"bootstrap and SDK inputs fit GitHub's ten-input dispatch limit",
	);
	assert.match(
		eventHeader,
		/role:\n\s+required: false\n\s+type: choice\n\s+options: \[acceptance, controller, worker\]\n\s+default: acceptance/u,
	);
	assert.deepEqual(
		Array.from(
			text.slice(text.indexOf("\njobs:\n")).matchAll(/^  ([a-z-]+):$/gmu),
			(match) => match[1],
		),
		["smoke", "dagger-native", "bootstrap-controller", "bootstrap-worker"],
	);
	for (const role of ["controller", "worker"]) {
		const block = repositoryBootstrapJob(text, `bootstrap-${role}`);
		assert.match(block, /^    runs-on: ubuntu-24\.04$/mu);
		assert.equal(
			block.split("\n").find((line) => line.startsWith("    if:")),
			`    if: \${{ inputs.role == '${role}' && github.event.repository.private == false }}`,
		);
		assert.match(block, /^    permissions:\n      contents: (?:read|write)$/mu);
		assert.doesNotMatch(block, /id-token:|secrets\./u);
		assert.equal((block.match(/persist-credentials: false/gu) ?? []).length, 1);
		assert.equal(
			(block.match(/ref: \$\{\{ github\.sha \}\}/gu) ?? []).length,
			1,
		);
		assert.doesNotMatch(block, /^\s+repository:/mu);
		assert.doesNotMatch(block, /^      GITHUB_TOKEN:/mu);
		assert.equal(
			(
				block.match(/^          GITHUB_TOKEN: \$\{\{ github\.token \}\}$/gmu) ??
				[]
			).length,
			1,
			"the API token is scoped to the run step, outside dependency installation",
		);
		const dependencyInstall =
			"        run: corepack pnpm install --filter hobo-design --frozen-lockfile --ignore-scripts";
		assert.ok(block.includes(dependencyInstall));
		assert.ok(
			block.indexOf(dependencyInstall) < block.indexOf(".mts prepare"),
			"locked dependency installation finishes before creating a bootstrap key",
		);
		for (const action of block.matchAll(/uses: ([^\s]+)$/gmu))
			assert.match(action[1] ?? "", /^[^@]+@[a-f0-9]{40}$/u);
		if (role === "controller") {
			assert.match(block, /^      contents: write$/mu);
			assert.match(block, /^    timeout-minutes: 180$/mu);
			assert.ok(block.includes("name: Publish controller public-key artifact"));
		} else {
			assert.match(block, /^      contents: read$/mu);
			assert.match(
				block,
				/^    timeout-minutes: \$\{\{ fromJSON\(inputs\.timeout_minutes\) \}\}$/mu,
			);
			assert.ok(
				block.includes(
					"      HOBO_BOOTSTRAP_LIFETIME_MS: ${{ inputs.lifetime_ms }}",
				),
			);
			assert.ok(
				block.includes(
					"      HOBO_BOOTSTRAP_TIMEOUT_MINUTES: ${{ inputs.timeout_minutes }}",
				),
			);
			assert.ok(
				block.includes(
					"name: Keep the disposable VM alive until verified cleanup\n        if: ${{ success() }}",
				),
			);
		}
	}
}

/** Remove only the reviewed repository-only additions, retaining SDK job bytes. */
function sdkAcceptanceProjection(text: string): string {
	assertRepositoryBootstrapBoundary(text);
	const operatorStart = text.indexOf("  bootstrap-controller:\n");
	assert.ok(operatorStart > 0);
	let projected = text.slice(0, operatorStart);
	const inputsStart = projected.indexOf("      role:\n");
	const sdkInputsStart = projected.indexOf("      jit_only:\n");
	assert.ok(inputsStart > 0 && sdkInputsStart > inputsStart);
	projected = projected.slice(0, inputsStart) + projected.slice(sdkInputsStart);
	const reviewedChanges: readonly [string, string][] = [
		[
			"run-name: hobo-bootstrap-${{ inputs.role }}-${{ inputs.lease_id }}\n",
			"",
		],
		[
			"group: hobo-ci-acceptance-${{ github.ref }}-${{ inputs.role }}-${{ inputs.lease_id }}",
			"group: hobo-ci-acceptance-${{ github.ref }}",
		],
		["    if: ${{ inputs.role == 'acceptance' || inputs.role == '' }}\n", ""],
		[
			"if: ${{ (inputs.role == 'acceptance' || inputs.role == '') && inputs.dagger_acceptance && !inputs.jit_only }}",
			"if: ${{ inputs.dagger_acceptance && !inputs.jit_only }}",
		],
	];
	for (const [repositoryOnly, sdk] of reviewedChanges) {
		assert.ok(projected.includes(repositoryOnly), repositoryOnly);
		projected = projected.replace(repositoryOnly, sdk);
	}
	return projected;
}

async function fixture(
	workflows: Record<string, string> = {},
	disabled: Record<string, string> = {},
) {
	const root = await mkdtemp(join(tmpdir(), "hobo-actions-policy-"));
	onTestFinished(() => rm(root, { recursive: true, force: true }));
	await mkdir(join(root, ".github/workflows"), { recursive: true });
	for (const [name, text] of Object.entries(workflows))
		await writeFile(join(root, ".github/workflows", name), text);
	if (Object.keys(disabled).length > 0) {
		await mkdir(join(root, ".github/workflows-disabled"), {
			recursive: true,
		});
		for (const [name, text] of Object.entries(disabled))
			await writeFile(join(root, ".github/workflows-disabled", name), text);
	}
	return root;
}
function lint(root: string) {
	return spawnSync(process.execPath, ["--experimental-strip-types", policy], {
		cwd: root,
		encoding: "utf8",
	});
}

test("trunk gates run the CI fabric contract while the standalone guard is PR-only", async () => {
	const workflow = await readFile(
		new URL("../.github/workflows/hobo-ci.yml", import.meta.url),
		"utf8",
	);
	const lines = workflow.split("\n");
	const jobText = (job: string) => {
		const start = lines.indexOf(`  ${job}:`);
		assert.notEqual(start, -1, `${job} exists`);
		const end = lines.findIndex(
			(line, index) => index > start && /^ {2}[A-Za-z0-9_-]+:$/u.test(line),
		);
		return lines.slice(start, end === -1 ? lines.length : end).join("\n");
	};

	for (const job of ["main-gate", "pr-gate"]) {
		const text = jobText(job);
		assert.match(
			text,
			/- name: CI runner image contract \(manifest\)\n(?:[ \t]+if: [^\n]+\n)?[ \t]+run: node --import tsx --test scripts\/test\/ci-runner-image-contract\.test\.ts/u,
			`${job} runs the runner image contract`,
		);
		assert.match(
			text,
			/- name: Assert CI fabric contract\n(?:[ \t]+if: [^\n]+\n)?[ \t]+run: node --import tsx packages\/ci-guard\/bin\/assert-ci-contract\.ts/u,
			`${job} asserts the CI fabric contract`,
		);
	}
	assert.match(
		jobText("pr-gate"),
		/- name: CI runner image contract \(manifest\)\n[ \t]+if: github\.event_name == 'merge_group'/u,
	);
	assert.match(
		jobText("pr-gate"),
		/- name: Assert CI fabric contract\n[ \t]+if: github\.event_name == 'merge_group'/u,
	);
	assert.match(
		jobText("ci-guard"),
		/^ {4}if: github\.event_name == 'pull_request'$/mu,
	);
});

test("workflow conditions never read the secrets context", async () => {
	const directory = new URL("../.github/workflows/", import.meta.url);
	const files = (await readdir(directory)).filter((name) =>
		/\.ya?ml$/u.test(name),
	);
	assert.ok(files.length > 0);
	for (const name of files) {
		const lines = (await readFile(new URL(name, directory), "utf8")).split(
			"\n",
		);
		for (const [index, line] of lines.entries()) {
			const match = /^(\s*)if:\s*(.*)$/u.exec(line);
			if (!match) continue;
			const indent = match[1]?.length ?? 0;
			const condition = [match[2] ?? ""];
			if (/^[>|][+-]?$/u.test(condition[0] ?? "")) {
				for (let next = index + 1; next < lines.length; next += 1) {
					const continuation = lines[next] ?? "";
					const leading = /^\s*/u.exec(continuation)?.[0].length ?? 0;
					if (continuation.trim() && leading <= indent) break;
					condition.push(continuation.trim());
				}
			}
			assert.doesNotMatch(
				condition.join(" "),
				/\bsecrets\./u,
				`${name}:${index + 1}`,
			);
		}
	}
});

test("repository operator modes preserve the independently installable SDK acceptance recipe", async () => {
	assert.equal(
		sdkAcceptanceProjection(repositoryAcceptance),
		template,
		"repository-only bootstrap modes must not alter the installable SDK job steps",
	);
	assert.doesNotMatch(
		template,
		/scripts\/ci-bootstrap|bootstrap-controller|bootstrap-worker/u,
	);
	for (const actual of [template, repositoryAcceptance]) {
		const result = lint(await fixture({ [enabled]: actual }));
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /1 enabled workflow/);
	}
});

for (const [name, original, changed] of [
	["automatic events", "  workflow_dispatch:", "  push:"],
	[
		"another hosted image",
		"    runs-on: ubuntu-24.04",
		"    runs-on: ubuntu-latest",
	],
	[
		"private repository execution",
		" && github.event.repository.private == false",
		"",
	],
	[
		"worker write access",
		"    permissions:\n      contents: read\n    env:\n      HOBO_BOOTSTRAP_LEASE_ID:",
		"    permissions:\n      contents: write\n    env:\n      HOBO_BOOTSTRAP_LEASE_ID:",
	],
	[
		"unlocked dependency installation",
		"--frozen-lockfile --ignore-scripts",
		"--ignore-scripts",
	],
	[
		"install scripts before key setup",
		"--frozen-lockfile --ignore-scripts",
		"--frozen-lockfile",
	],
	[
		"a disabled cleanup boundary",
		"        if: ${{ success() }}",
		"        if: ${{ always() }}",
	],
	[
		"an extra hosted job",
		"jobs:\n",
		"jobs:\n  unrelated:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: true\n",
	],
] as const) {
	test(`repository operator recipe refuses ${name}`, async () => {
		assert.ok(repositoryAcceptance.includes(original));
		const result = lint(
			await fixture({
				[enabled]: repositoryAcceptance.replace(original, changed),
			}),
		);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /differs from its reviewed recipe/);
	});
}
test("authoritative CI workflows are an allowed enabled set", async () => {
	const minimalHoboCi = `name: HoBo CI Fabric
on:
  push:
    branches: [main]
  pull_request:
jobs:
  pr-gate:
    if: github.event_name == 'pull_request'
    runs-on: hobo
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          clean: false
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
const trunkRunsOn =
	"${{ vars.HOBO_CI_TRUNK_RUNNER != 'false' && contains(fromJSON('[\"push\",\"workflow_dispatch\",\"merge_group\",\"workflow_run\"]'), github.event_name) && 'hobo-trunk' || 'hobo' }}";

test("repo-local composite actions require a prior pinned actions/checkout step", async () => {
	const disabledBad = `name: x
on:
  workflow_dispatch:
jobs:
  job:
    if: \${{ false }}
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/hobo-checkout
`;
	const disabledGood = `name: x
on:
  workflow_dispatch:
jobs:
  job:
    if: \${{ false }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683
        with:
          sparse-checkout: .github/actions
      - uses: ./.github/actions/hobo-checkout
`;
	const badResult = lint(
		await fixture({}, { "local-action-guard.yml": disabledBad }),
	);
	assert.equal(badResult.status, 1);
	assert.match(
		badResult.stderr,
		/repo-local action \.\/\.github\/actions\/hobo-checkout must follow a pinned actions\/checkout step/,
	);
	assert.equal(
		lint(await fixture({}, { "local-action-guard.yml": disabledGood })).status,
		0,
	);
});

test("default-path checkouts on box runners keep the deps layer with clean false", async () => {
	const workflow = (inputs: string, runsOn = "hobo") => `name: HoBo CI Fabric
on:
  push:
    branches: [main]
jobs:
  pr-gate:
    runs-on: ${runsOn}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683${inputs}
`;
	assert.equal(
		lint(
			await fixture({
				"hobo-ci.yml": workflow(
					"\n        with:\n          clean: false",
					trunkRunsOn,
				),
			}),
		).status,
		0,
	);
	for (const inputs of [
		"",
		"\n        with:\n          clean: true",
		"\n        with:\n          repository: Hobo-Labs/HoBo",
	]) {
		const result = lint(await fixture({ "hobo-ci.yml": workflow(inputs) }));
		assert.equal(result.status, 1);
		assert.match(result.stderr, /must set clean: false/);
	}
	for (const inputs of [
		"\n        with:\n          path: elsewhere",
		"\n        with:\n          repository: Hobo-Labs/ts-autocode",
	])
		assert.equal(
			lint(
				await fixture({
					"hobo-ci.yml": workflow(inputs, trunkRunsOn),
				}),
			).status,
			0,
		);
});

test("authoritative CI jobs choose between hobo and the trunk label only", async () => {
	const hoboCi = (runsOn: string) => `name: HoBo CI Fabric
on:
  push:
    branches: [main]
  pull_request:
jobs:
  pr-gate:
    if: github.event_name == 'pull_request'
    runs-on: hobo
    steps:
      - run: true
  main-gate:
    runs-on: ${runsOn}
    steps:
      - run: true
`;
	const accepted = lint(await fixture({ "hobo-ci.yml": hoboCi(trunkRunsOn) }));
	assert.equal(accepted.status, 0, accepted.stderr);
	const trunkOnPr = hoboCi(trunkRunsOn).replace(
		"runs-on: hobo",
		`runs-on: ${trunkRunsOn}`,
	);
	const rejectedTrunkOnPr = lint(
		await fixture({ "release-hobo.yml": trunkOnPr }),
	);
	assert.equal(rejectedTrunkOnPr.status, 1);
	assert.match(rejectedTrunkOnPr.stderr, /PR-only jobs must use plain hobo/);
	for (const runsOn of [
		"${{ vars.HOBO_CI_TRUNK_RUNNER }}",
		trunkRunsOn.replace("'hobo-trunk'", "'ubuntu-latest'"),
		"ubuntu-latest",
	]) {
		const result = lint(await fixture({ "hobo-ci.yml": hoboCi(runsOn) }));
		assert.equal(result.status, 1, runsOn);
		assert.match(result.stderr, /runs-on must be hobo or the trunk label/);
	}
});

test("trunk-label-routing rejects shared hobo on push, merge-group and dispatch jobs", async () => {
	const workflow = (event: string, runsOn: string) => `name: Routing
on:
  ${event}:
jobs:
  build:
    runs-on: ${runsOn}
    steps:
      - run: true
`;
	for (const event of [
		"push",
		"merge_group",
		"workflow_dispatch",
		"workflow_run",
	]) {
		const shared = lint(
			await fixture({ "pricing-ci.yml": workflow(event, "hobo") }),
		);
		assert.equal(shared.status, 1, event);
		assert.match(
			shared.stderr,
			/trunk-label-routing: push\/merge_group\/workflow_dispatch-capable jobs must use the trunk label expression/,
		);
		const trunk = lint(
			await fixture({ "pricing-ci.yml": workflow(event, trunkRunsOn) }),
		);
		assert.equal(trunk.status, 0, trunk.stderr);
	}
});

test("trunk-label-routing requires plain hobo on PR-only jobs, including folded conditions", async () => {
	const workflow = (runsOn: string) => `name: Routing
on:
  pull_request:
  workflow_dispatch:
jobs:
  build:
    if: >-
      github.event_name == 'pull_request' &&
      contains(github.event.pull_request.labels.*.name, 'hobo/e2e')
    runs-on: ${runsOn}
    steps:
      - run: true
`;
	const shared = lint(await fixture({ "examples-e2e.yml": workflow("hobo") }));
	assert.equal(shared.status, 0, shared.stderr);
	const trunk = lint(
		await fixture({ "examples-e2e.yml": workflow(trunkRunsOn) }),
	);
	assert.equal(trunk.status, 1);
	assert.match(
		trunk.stderr,
		/trunk-label-routing: PR-only jobs must use plain hobo/,
	);
	const prOnlyWorkflow = lint(
		await fixture({
			"examples-e2e.yml": workflow(trunkRunsOn).replace(
				"  workflow_dispatch:\n",
				"",
			),
		}),
	);
	assert.equal(prOnlyWorkflow.status, 1);
	assert.match(prOnlyWorkflow.stderr, /PR-only jobs must use plain hobo/);
});

test("every trunk-capable CI and release job requests the trunk label by default", async () => {
	for (const file of [
		"hobo-ci.yml",
		"hobo-ci-acceptance.yml",
		"examples-e2e.yml",
		"dev-env-smoke.yml",
		"release-hobo.yml",
		"release-code.yml",
		"pricing-ci.yml",
		"release-pricing.yml",
	]) {
		const text = await readFile(
			new URL(`../.github/workflows/${file}`, import.meta.url),
			"utf8",
		);
		const lines = text.split("\n");
		const jobsIndex = lines.indexOf("jobs:");
		assert.notEqual(jobsIndex, -1, file);
		const starts = lines
			.map((line, index) => ({ line, index }))
			.filter(
				({ line, index }) =>
					index > jobsIndex && /^  [A-Za-z0-9_-]+:$/.test(line),
			)
			.map(({ index }) => index);
		assert.ok(starts.length > 0, file);
		for (const [position, start] of starts.entries()) {
			const block = lines
				.slice(start, starts[position + 1] ?? lines.length)
				.join("\n");
			const runsOn = block.match(/^    runs-on: (.*)$/m)?.[1];
			assert.ok(runsOn, `${file}:${lines[start]} has no runs-on`);
			if (
				file === "release-hobo.yml" &&
				(lines[start] ?? "").startsWith("  release-npm:")
			) {
				assert.equal(
					runsOn,
					"ubuntu-24.04",
					`${file}:${lines[start]} release-npm must use GitHub-hosted runners for npm OIDC`,
				);
				continue;
			}
			if (
				file === enabled &&
				["  bootstrap-controller:", "  bootstrap-worker:"].includes(
					lines[start] ?? "",
				)
			) {
				assertRepositoryBootstrapBoundary(text);
				continue;
			}
			const condition =
				block.match(/^    if:([^\n]*(?:\n      [^\n]*)*)/m)?.[1] ?? "";
			const prOnly =
				/github\.event_name == 'pull_request'/.test(condition) &&
				!condition.includes("||");
			assert.equal(
				runsOn,
				prOnly ? "hobo" : trunkRunsOn,
				`${file}:${lines[start]}`,
			);
		}
	}
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
	[
		"hosted runner fallback",
		`runs-on: ${trunkRunsOn}`,
		"runs-on: ubuntu-latest",
	],
	[
		"dynamic runner override",
		`runs-on: ${trunkRunsOn}`,
		"runs-on: ${{ vars.RUNNER }}",
	],
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
		`    runs-on: ${trunkRunsOn}`,
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
