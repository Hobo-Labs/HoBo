import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
	applyWorkflowPlan,
	DEFAULT_FLEET_LABEL,
	describeWorkflowSkip,
	describeWorkflowWarning,
	FLEET_RUNNER_LABELS,
	planWorkflow,
	WORKFLOW_SKIP_REASONS,
	WORKFLOW_WARNINGS,
	type WorkflowInitOptions,
	type WorkflowPlan,
} from "../src/workflow-init.js";

const FILE = ".github/workflows/ci.yml";

function standings(plan: WorkflowPlan): readonly string[] {
	return plan.jobs.map((job) =>
		job.reason === undefined
			? `${job.job} ${job.verdict}`
			: `${job.job} ${job.verdict} ${job.reason}`,
	);
}

function oneJob(body: string): string {
	return `on: push\njobs:\n  job:\n${body}`;
}

function planOf(source: string, options?: Partial<WorkflowInitOptions>) {
	const plan = planWorkflow(FILE, source, options);
	expect(plan.error).toBeUndefined();
	return plan;
}

function onlyJob(source: string, options?: Partial<WorkflowInitOptions>) {
	const [job, ...others] = planOf(source, options).jobs;
	expect(others).toEqual([]);
	if (job === undefined) throw new Error("the workflow has no job");
	return job;
}

function changedLines(before: string, after: string): readonly string[] {
	const was = before.split("\n");
	const now = after.split("\n");
	expect(now).toHaveLength(was.length);
	return now.filter((line, index) => line !== was[index]);
}

function meaningWithout(source: string, jobs: readonly string[]) {
	const doc = parseDocument(source);
	expect(doc.errors).toEqual([]);
	for (const job of jobs) doc.setIn(["jobs", job, "runs-on"], "set aside");
	return doc.toJS();
}

const VERDICTS = `name: CI
on: push
jobs:
  build:
    name: Build and test
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm test
  call:
    uses: ./.github/workflows/release.yml
    secrets: inherit
  call-with-secret:
    name: 42
    uses: acme/workflows/.github/workflows/publish.yml@v1
    secrets:
      token: \${{ secrets.PUBLISH_TOKEN }}
  no-runner:
    steps:
      - run: echo nothing to run on
  empty-runner:
    runs-on:
  empty-list:
    runs-on: []
  not-a-job: later
  group:
    runs-on: { group: big }
  group-block:
    runs-on:
      group: big
      labels: [linux]
  group-from-input:
    runs-on:
      group: \${{ inputs.group }}
  matrix-os:
    runs-on: \${{ matrix.os }}
  expression-in-list:
    runs-on: [self-hosted, "\${{ inputs.size }}"]
  expression-alone-in-list:
    runs-on:
      - \${{ needs.pick.outputs.runner }}
  self-hosted-list:
    runs-on: [self-hosted, linux]
  self-hosted-list-caps:
    runs-on: [Self-Hosted, X64]
  two-labels:
    runs-on: [ubuntu-24.04, gpu]
  nested-list:
    runs-on: [[ubuntu-24.04]]
  one-in-list:
    runs-on: [ubuntu-24.04]
  on-fleet:
    runs-on: hobo
  on-trunk:
    runs-on: hobo-trunk
  on-box-caps:
    runs-on: HOBO-BOX
  on-fleet-in-list:
    runs-on: [hobo]
  self-hosted:
    runs-on: self-hosted
  self-hosted-alone-in-list:
    runs-on: [self-hosted]
  blacksmith:
    runs-on: blacksmith-4vcpu-ubuntu-2404
  arm:
    runs-on: ubuntu-24.04-arm
  mac:
    runs-on: macos-15
  windows:
    runs-on: windows-2025
  unknown:
    runs-on: big-box-01
  number:
    runs-on: 2404
  padded:
    runs-on: " ubuntu-24.04"
`;

describe("planWorkflow verdicts", () => {
	it("gives every job one verdict, in file order", () => {
		expect(standings(planOf(VERDICTS))).toEqual([
			"build ready",
			"call skipped reusable_workflow",
			"call-with-secret skipped reusable_workflow",
			"no-runner skipped no_runs_on",
			"empty-runner skipped no_runs_on",
			"empty-list skipped no_runs_on",
			"not-a-job skipped no_runs_on",
			"group skipped label_group",
			"group-block skipped label_group",
			"group-from-input skipped label_group",
			"matrix-os skipped expression",
			"expression-in-list skipped expression",
			"expression-alone-in-list skipped expression",
			"self-hosted-list skipped self_hosted",
			"self-hosted-list-caps skipped self_hosted",
			"two-labels skipped label_group",
			"nested-list skipped label_group",
			"one-in-list ready",
			"on-fleet routed",
			"on-trunk routed",
			"on-box-caps routed",
			"on-fleet-in-list routed",
			"self-hosted skipped self_hosted",
			"self-hosted-alone-in-list skipped self_hosted",
			"blacksmith skipped provider_label",
			"arm skipped not_linux_x64",
			"mac skipped not_linux_x64",
			"windows skipped not_linux_x64",
			"unknown skipped self_hosted",
			"number skipped self_hosted",
			"padded skipped self_hosted",
		]);
	});

	it("reports the file, the name and the runs-on as written", () => {
		const plan = planOf(VERDICTS);
		const written = new Map(plan.jobs.map((job) => [job.job, job.runsOn]));
		expect(plan.file).toBe(FILE);
		expect(plan.jobs.every((job) => job.file === FILE)).toBe(true);
		expect(plan.jobs[0]).toEqual({
			file: FILE,
			job: "build",
			name: "Build and test",
			verdict: "ready",
			runsOn: "ubuntu-24.04",
			reason: undefined,
			warnings: [],
		});

		expect(plan.jobs[2]?.name).toBeUndefined();
		expect(written.get("call")).toBe("");
		expect(written.get("no-runner")).toBe("");
		expect(written.get("group")).toBe("{ group: big }");
		expect(written.get("group-block")).toBe("group: big labels: [linux]");
		expect(written.get("matrix-os")).toBe("${{ matrix.os }}");
		expect(written.get("self-hosted-list")).toBe("self-hosted, linux");
		expect(written.get("one-in-list")).toBe("ubuntu-24.04");
		expect(written.get("on-box-caps")).toBe("HOBO-BOX");
	});

	it("only attaches warnings to ready jobs and reasons to skipped ones", () => {
		for (const job of planOf(VERDICTS).jobs) {
			expect(job.reason !== undefined).toBe(job.verdict === "skipped");
			if (job.verdict !== "ready") expect(job.warnings).toEqual([]);
		}
	});

	it("decides the label before it looks for secrets", () => {
		const deploy = "    environment: production\n";
		const verdictOn = (runsOn: string) =>
			standings(planOf(oneJob(`    runs-on: ${runsOn}\n${deploy}`)));
		expect(verdictOn("hobo")).toEqual(["job routed"]);
		expect(verdictOn("macos-15")).toEqual(["job skipped not_linux_x64"]);
		expect(verdictOn("depot-ubuntu-24.04")).toEqual([
			"job skipped provider_label",
		]);
		expect(verdictOn("self-hosted")).toEqual(["job skipped self_hosted"]);
		expect(verdictOn("ubuntu-24.04")).toEqual(["job skipped uses_secrets"]);
	});

	it("treats a list of one label as that label", () => {
		const verdictOn = (runsOn: string) =>
			standings(planOf(oneJob(`    runs-on: ${runsOn}\n`)));
		expect(verdictOn("[ubuntu-latest]")).toEqual(["job ready"]);
		expect(verdictOn("[macos-15]")).toEqual(["job skipped not_linux_x64"]);
		expect(verdictOn("[namespace-profile-default]")).toEqual([
			"job skipped provider_label",
		]);
		expect(verdictOn("\n      - ubuntu-24.04")).toEqual(["job ready"]);
	});
});

describe("planWorkflow deploy-like jobs", () => {
	const ready = (body: string, options?: Partial<WorkflowInitOptions>) =>
		standings(planOf(oneJob(`    runs-on: ubuntu-24.04\n${body}`), options));

	it.each([
		["an environment", "    environment: production\n"],
		["an environment mapping", "    environment:\n      name: staging\n"],
		["write-all permissions", "    permissions: write-all\n"],
		[
			"repository write permission",
			"    permissions:\n      contents: write\n",
		],
		[
			"package publishing permission",
			"    permissions:\n      packages: write\n      contents: read\n",
		],
		[
			"an id-token permission",
			"    permissions:\n      contents: read\n      id-token: write\n",
		],
		[
			"a secret in a step",
			"    steps:\n      - run: ./deploy.sh\n        env:\n          TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n",
		],
		[
			"a secret in a condition",
			"    if: ${{ secrets.DEPLOY_TOKEN != '' }}\n    steps: []\n",
		],
		[
			"a bracketed secret",
			"    env:\n      TOKEN: ${{ secrets['DEPLOY_TOKEN'] }}\n",
		],
		[
			"a computed secret",
			"    env:\n      TOKEN: ${{ secrets[format('{0}_TOKEN', 'DEPLOY')] }}\n",
		],
		[
			"the whole secrets context",
			"    env:\n      CONTEXT: ${{ toJSON(secrets) }}\n",
		],
		["a bare secrets context", "    if: ${{ secrets }}\n    steps: []\n"],
		["inherited secrets", "    secrets: inherit\n"],
		[
			"a filter after GITHUB_TOKEN",
			"    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN.* }}\n",
		],
		[
			"a bracket filter after GITHUB_TOKEN",
			"    env:\n      TOKEN: ${{ secrets['GITHUB_TOKEN'][*] }}\n",
		],
		[
			"a property after GITHUB_TOKEN",
			"    env:\n      TOKEN: ${{ secrets['GITHUB_TOKEN']['password'] }}\n",
		],
		[
			"a hyphen continuing GITHUB_TOKEN",
			"    env:\n      TOKEN: ${{ secrets.GITHUB_TOKEN-extra }}\n",
		],
	])("skips a job with %s", (_what, body) => {
		expect(ready(body)).toEqual(["job skipped uses_secrets"]);
		expect(ready(body, { includeSecretJobs: true })).toEqual(["job ready"]);
	});

	it("does not rewrite a job with a write-scoped token by default", () => {
		const source = oneJob(
			"    runs-on: ubuntu-24.04\n    permissions:\n      contents: write\n",
		);
		expect(applyWorkflowPlan(FILE, source, ["all"])).toMatchObject({
			source,
			changed: [],
		});
	});

	it.each([
		["nothing of the kind", "    steps:\n      - run: pnpm test\n"],
		[
			"only GITHUB_TOKEN",
			"    steps:\n      - run: gh pr list\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
		],
		[
			"GITHUB_TOKEN in another case",
			"    env:\n      GH_TOKEN: ${{ secrets.github_token }}\n",
		],
		[
			"GITHUB_TOKEN in brackets",
			"    env:\n      GH_TOKEN: ${{ secrets['GITHUB_TOKEN'] }}\n",
		],
		[
			"GITHUB_TOKEN in double quotes",
			'    env:\n      GH_TOKEN: ${{ secrets["GITHUB_TOKEN"] }}\n',
		],
		["read permissions", "    permissions:\n      contents: read\n"],
		["no id-token", "    permissions:\n      id-token: none\n"],
		["read-all permissions", "    permissions: read-all\n"],
	])("leaves a job with %s ready", (_what, body) => {
		expect(ready(body)).toEqual(["job ready"]);
	});

	it("finds a secret that the job reaches through an alias", () => {
		const source = `on: push
env-for-deploys: &deploy_env
  TOKEN: \${{ secrets.DEPLOY_TOKEN }}
jobs:
  ship:
    runs-on: ubuntu-24.04
    env: *deploy_env
  test:
    runs-on: ubuntu-24.04
`;
		expect(standings(planOf(source))).toEqual([
			"ship skipped uses_secrets",
			"test ready",
		]);
	});

	it("counts the workflow's permissions for a job that sets none", () => {
		const source = `on: push
permissions:
  contents: write
jobs:
  inherits:
    runs-on: ubuntu-24.04
  narrows:
    runs-on: ubuntu-24.04
    permissions:
      contents: read
`;
		expect(standings(planOf(source))).toEqual([
			"inherits skipped uses_secrets",
			"narrows ready",
		]);
	});

	it("skips a job that only consumes outputs from a secret-bearing upstream", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - id: token
        run: echo "value=1" >> "$GITHUB_OUTPUT"
        env:
          TOKEN: \${{ secrets.PUBLISH_TOKEN }}
  ship:
    needs: publish
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ needs.publish.outputs.value }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
		expect(applyWorkflowPlan(FILE, source, ["all"]).changed).toHaveLength(0);
	});

	it("counts needs outputs when the job id has a regex metacharacter and the quote is YAML-escaped", () => {
		const source = `on: push
jobs:
  "publish.v2":
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ needs[\\"publish.v2\\"].outputs.value }}"
`;
		expect(standings(planOf(source))).toEqual([
			"publish.v2 skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it("follows a needs alias to a secret-bearing job", () => {
		const source = `on: push
jobs:
  publish:
    name: &publish_name publish
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    needs:
      - *publish_name
  also:
    runs-on: ubuntu-24.04
    needs: *publish_name
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
			"also skipped uses_secrets",
		]);
	});

	it.each([
		"needs.publish['outputs'].value",
		"needs['publish']['outputs']['value']",
		"needs[ 'publish' ][ 'outputs' ]",
		String.raw`needs[\"publish\"][\"outputs\"].value`,
	])("counts secret outputs read with index syntax %s", (reference) => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ ${reference} }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it("counts an expression-escaped job id in a needs output read", () => {
		const source = `on: push
jobs:
  "a'b":
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ needs['a''b'].outputs.value }}
`;
		expect(standings(planOf(source))).toEqual([
			"a'b skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it("counts toJSON of a secret job object as an output read", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ toJSON(needs.publish) }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it.each([
		"NEEDS.PUBLISH.OUTPUTS.value",
		"Needs['Publish']['Outputs'].value",
		"tojson(needs.publish)",
		"toJSON((needs.publish))",
		"TOJSON( ( NEEDS.PUBLISH ) )",
	])("counts a case-insensitive secret output read %s", (reference) => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ ${reference} }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it.each([
		"(needs).publish.outputs.value",
		"( needs )['publish']['outputs'].value",
		"((needs)).publish.outputs.value",
		"!(needs).publish.outputs.value",
		"toJSON((needs).publish)",
		"TOJSON( ( ( NEEDS ) . PUBLISH ) )",
		"(needs)[format('{0}', 'publish')].outputs.value",
		"(( needs ))[inputs.job]['outputs'].value",
		"toJSON((needs)[inputs.job])",
	])("fails closed when a grouped needs context reads %s", (reference) => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ ${reference} }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it("counts a grouped wildcard needs read only when that job is needed", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    needs: publish
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ toJSON((needs).*) }}
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ (needs).*.outputs.value }}
      - run: echo \${{ (NEEDS)[ '*' ].OUTPUTS.value }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
			"lint ready",
		]);
	});

	it("does not treat a grouped needs read of another job as this job's secrets", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ (needs).other.outputs.value }}
      - run: echo \${{ (needs).publish.result }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship ready",
		]);
	});

	it("counts a needs id that differs only by case as a secret dependency", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    needs: Publish
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it("counts a case-insensitive wildcard needs read when that job is needed", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    needs: Publish
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ TOJSON(NEEDS) }}
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ NEEDS.*.OUTPUTS.value }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
			"lint ready",
		]);
	});

	it("fails closed when a dynamic needs index differs by case", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ NEEDS[format('{0}', 'publish')]['OUTPUTS'].value }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it("counts a wildcard needs output read when the secret job is needed", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    needs: publish
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ toJSON(needs.*.outputs) }}
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ toJSON(needs.*.outputs) }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
			"lint ready",
		]);
	});

	it("fails closed when a needs output index is not a literal", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ needs[format('{0}', 'publish')]['outputs'].value }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it.each([
		"needs[format('{0}', 'publish')].*",
		"NEEDS[format('{0}', 'publish')]['*']",
		"(needs[format('{0}', 'publish')]).*",
		"needs[format('{0}', 'publish')][format('{0}', 'outputs')].value",
		"needs[inputs.job][inputs.key]",
		"toJSON(needs[inputs.job].*)",
	])("fails closed when a dynamic needs index reads %s", (reference) => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ ${reference} }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it("does not treat a wildcard star as a secret read unless that job is needed", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  other:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  ship:
    needs: other
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ needs.*.* }}
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ NEEDS.*[format('{0}', 'outputs')] }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"other ready",
			"ship ready",
			"lint ready",
		]);
	});

	it.each([
		"needs.publish.*",
		"NEEDS.PUBLISH['*']",
		"toJSON(needs.publish.*)",
		"(needs.publish).*",
		"needs.publish[format('{0}', 'outputs')].value",
		"needs['publish'][inputs.key]",
	])("counts a fail-closed secret property read %s", (reference) => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ ${reference} }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
		]);
	});

	it("does not treat a star or result on another property as this job's secret outputs", () => {
		const starOnOther = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ needs.other.* }}
`;
		const resultIndex = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ needs.publish['result'] }}
`;
		expect(standings(planOf(starOnOther))).toEqual([
			"publish skipped uses_secrets",
			"ship ready",
		]);
		expect(standings(planOf(resultIndex))).toEqual([
			"publish skipped uses_secrets",
			"ship ready",
		]);
	});

	it("fails closed when needs cannot be read and a secret job exists", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    needs: \${{ inputs.job }}
    runs-on: ubuntu-24.04
  plain:
    needs: \${{ inputs.job }}
    runs-on: ubuntu-24.04
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship skipped uses_secrets",
			"plain skipped uses_secrets",
		]);
		const onlyPlain = `on: push
jobs:
  plain:
    needs: \${{ inputs.job }}
    runs-on: ubuntu-24.04
`;
		expect(standings(planOf(onlyPlain))).toEqual(["plain ready"]);
	});

	it("does not treat a result check as a secret output read", () => {
		const source = `on: push
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - run: echo "\${{ secrets.PUBLISH_TOKEN }}"
  ship:
    runs-on: ubuntu-24.04
    steps:
      - run: echo \${{ needs.publish.result }}
`;
		expect(standings(planOf(source))).toEqual([
			"publish skipped uses_secrets",
			"ship ready",
		]);
	});

	it("counts a secret in the workflow's env for every job", () => {
		const source = `on: push
env:
  NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
jobs:
  test:
    runs-on: ubuntu-24.04
`;
		expect(standings(planOf(source))).toEqual(["test skipped uses_secrets"]);
		expect(standings(planOf(source, { includeSecretJobs: true }))).toEqual([
			"test ready",
		]);
	});

	it.each([
		["an environment", "    <<: &deploy\n      environment: production\n"],
		["inherited secrets", "    <<: &deploy\n      secrets: inherit\n"],
		[
			"write permissions",
			"    <<: &deploy\n      permissions:\n        contents: write\n",
		],
		[
			"nested write permissions",
			"    permissions:\n      <<: &write\n        contents: write\n",
		],
		[
			"a secret in merged env",
			"    <<: &deploy\n      env:\n        TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n",
		],
	])("skips a job with %s behind a YAML merge key", (_what, body) => {
		expect(ready(body)).toEqual(["job skipped uses_secrets"]);
		expect(ready(body, { includeSecretJobs: true })).toEqual(["job ready"]);
	});

	it.each([
		"permissions",
		"env",
	])("counts workflow %s behind a YAML merge key", (key) => {
		const value =
			key === "permissions"
				? "contents: write"
				: "TOKEN: ${{ secrets.DEPLOY_TOKEN }}";
		const source = `on: push
defaults: &defaults
  ${key}:
    ${value}
<<: *defaults
jobs:
  test:
    runs-on: ubuntu-24.04
`;
		expect(standings(planOf(source))).toEqual(["test skipped uses_secrets"]);
	});

	it("lets a direct permissions mapping override a merged one", () => {
		const source = oneJob(`    runs-on: ubuntu-24.04
    <<: &deploy
      permissions: write-all
    permissions:
      contents: read
`);
		expect(standings(planOf(source))).toEqual(["job ready"]);
	});
});

describe("planWorkflow warnings", () => {
	const warningsOf = (runsOn: string, body: string) =>
		onlyJob(oneJob(`    runs-on: ${runsOn}\n${body}`)).warnings;

	it("has none for a plain job on a pinned image", () => {
		expect(
			warningsOf("ubuntu-24.04", "    steps:\n      - run: pnpm test\n"),
		).toEqual([]);
	});

	it.each([
		["services", "    services:\n      db:\n        image: postgres:17\n"],
		["a container", "    container: node:24\n"],
		[
			"a Docker action",
			"    steps:\n      - uses: docker://alpine:3.22\n        with:\n          args: echo hi\n",
		],
	])("warns that a job with %s needs Docker", (_what, body) => {
		expect(warningsOf("ubuntu-24.04", body)).toEqual(["needs_docker"]);
	});

	it.each([
		["apt-get install", "sudo apt-get install -y jq"],
		[
			"apt-get with flags first",
			"apt-get -y --no-install-recommends install jq",
		],
		["apt install", "apt install jq"],
		["yum install", "yum install -y jq"],
		["dnf install", "dnf -y install jq"],
		["apk install", "apk install jq"],
		["sudo", "sudo systemctl start docker"],
		["a later line", "|\n          set -e\n          sudo apt-get update"],
		["a folded script", ">\n          set -e\n          dnf install -y jq"],
	])("warns about %s in a step", (_what, script) => {
		expect(
			warningsOf("ubuntu-24.04", `    steps:\n      - run: ${script}\n`),
		).toEqual(["installs_packages"]);
	});

	it("does not mistake other commands for package installs", () => {
		expect(
			warningsOf(
				"ubuntu-24.04",
				"    steps:\n      - run: pnpm install && npm install -g corepack\n      - uses: actions/checkout@v5\n",
			),
		).toEqual([]);
	});

	it("warns that ubuntu-latest moves", () => {
		expect(warningsOf("ubuntu-latest", "    steps: []\n")).toEqual([
			"moving_image",
		]);
		expect(warningsOf("[Ubuntu-Latest]", "    steps: []\n")).toEqual([
			"moving_image",
		]);
	});

	it("warns about a matrix", () => {
		expect(
			warningsOf(
				"ubuntu-24.04",
				"    strategy:\n      matrix:\n        node: [22, 24]\n",
			),
		).toEqual(["matrix"]);
		expect(
			warningsOf("ubuntu-24.04", "    strategy:\n      fail-fast: false\n"),
		).toEqual([]);
	});

	it("lists every warning in the declared order", () => {
		const body = `    strategy:
      matrix:
        shard: [1, 2]
    steps:
      - run: sudo apt-get install -y libpq-dev
    container: node:24
`;
		expect(warningsOf("ubuntu-latest", body)).toEqual([...WORKFLOW_WARNINGS]);
	});
});

describe("planWorkflow options", () => {
	it("defaults to the fleet's own label", () => {
		expect(DEFAULT_FLEET_LABEL).toBe("hobo");
		expect(FLEET_RUNNER_LABELS).toContain(DEFAULT_FLEET_LABEL);
	});

	it("counts a job on a custom fleet label as routed", () => {
		const source = oneJob("    runs-on: Acme-Fleet\n");
		expect(standings(planOf(source))).toEqual(["job skipped self_hosted"]);
		expect(standings(planOf(source, { fleetLabel: "acme-fleet" }))).toEqual([
			"job routed",
		]);

		expect(
			standings(
				planOf(oneJob("    runs-on: hobo-trunk\n"), {
					fleetLabel: "acme-fleet",
				}),
			),
		).toEqual(["job routed"]);
	});

	it("falls back to the default for a blank fleet label", () => {
		const source = oneJob("    runs-on: ubuntu-24.04\n");
		expect(
			applyWorkflowPlan(FILE, source, ["all"], { fleetLabel: " " }).source,
		).toBe(oneJob("    runs-on: hobo # was ubuntu-24.04\n"));
	});
});

const ANCHORED = `on: push
jobs:
  first:
    runs-on: &runner ubuntu-24.04
    steps: &steps
      - run: sudo apt-get install -y jq
  second:
    runs-on: *runner
    steps: *steps
  third: &third
    runs-on: ubuntu-latest
  fourth: *third
  fifth:
    runs-on: [&pinned ubuntu-24.04]
  sixth:
    runs-on: [*pinned]
`;

describe("planWorkflow on YAML anchors", () => {
	it("reads a job through its aliases", () => {
		const plan = planOf(ANCHORED);
		expect(standings(plan)).toEqual([
			"first ready",
			"second ready",
			"third ready",
			"fourth ready",
			"fifth ready",
			"sixth ready",
		]);
		expect(plan.jobs.map((job) => job.runsOn)).toEqual([
			"ubuntu-24.04",
			"ubuntu-24.04",
			"ubuntu-latest",
			"ubuntu-latest",
			"ubuntu-24.04",
			"ubuntu-24.04",
		]);
		expect(plan.jobs[1]?.warnings).toEqual(["installs_packages"]);
		expect(plan.jobs[3]?.warnings).toEqual(["moving_image"]);
	});

	it("rewrites an alias but refuses a value other places stand for", () => {
		const result = applyWorkflowPlan(FILE, ANCHORED, ["all"]);
		expect(result.changed).toEqual(["second", "sixth"]);
		expect(result.refused.map((refusal) => refusal.job)).toEqual([
			"first",
			"third",
			"fourth",
			"fifth",
		]);
		for (const refusal of result.refused) {
			expect(refusal.why).toContain("YAML anchor");
		}
		expect(changedLines(ANCHORED, result.source)).toEqual([
			"    runs-on: hobo # was ubuntu-24.04",
			"    runs-on: hobo # was ubuntu-24.04",
		]);
		expect(standings(planOf(result.source))).toEqual([
			"first ready",
			"second routed",
			"third ready",
			"fourth ready",
			"fifth ready",
			"sixth routed",
		]);
	});

	it("skips runs-on inherited through a YAML merge key", () => {
		const source = `on: push
job-defaults: &job-defaults
  runs-on: ubuntu-24.04
  steps:
    - run: pnpm test
jobs:
  merged:
    <<: *job-defaults
`;
		expect(standings(planOf(source))).toEqual(["merged skipped no_runs_on"]);
		expect(applyWorkflowPlan(FILE, source, ["all"])).toEqual({
			source,
			changed: [],
			refused: [],
		});
		expect(applyWorkflowPlan(FILE, source, ["merged"]).source).toBe(source);
	});
});

describe("applyWorkflowPlan on a shared jobs mapping", () => {
	it("refuses jobs that an anchor on jobs shares with another key", () => {
		const source = `on: push
jobs: &jobs
  test:
    runs-on: ubuntu-24.04
copy-of-jobs: *jobs
`;
		expect(standings(planOf(source))).toEqual(["test ready"]);
		const result = applyWorkflowPlan(FILE, source, ["test"]);
		expect(result.source).toBe(source);
		expect(result.changed).toEqual([]);
		expect(result.refused.map((refusal) => refusal.job)).toEqual(["test"]);
		expect(result.refused[0]?.why).toContain("YAML anchor");
	});
});

describe("planWorkflow on a file it cannot plan", () => {
	it("reports YAML that does not parse in one sentence", () => {
		const plan = planWorkflow(FILE, "jobs:\n  build: [\n  test: }\n");
		expect(plan.file).toBe(FILE);
		expect(plan.jobs).toEqual([]);
		expect(plan.error).toMatch(/^The file is not valid YAML: .+ line 3.*\.$/u);
		expect(plan.error).not.toContain("\n");
	});

	it("reports a duplicated job id as YAML that does not parse", () => {
		const plan = planWorkflow(
			FILE,
			"jobs:\n  a:\n    runs-on: hobo\n  a:\n    runs-on: hobo\n",
		);
		expect(plan.jobs).toEqual([]);
		expect(plan.error).toMatch(/^The file is not valid YAML: /u);
	});

	it.each([
		["no jobs key", "name: CI\non: push\n"],
		["an empty file", ""],
		["a list of jobs", "jobs:\n  - runs-on: ubuntu-24.04\n"],
		["a top-level list", "- jobs\n"],
		["a scalar", "jobs\n"],
	])("reports %s as a file with no jobs mapping", (_what, source) => {
		expect(planWorkflow(FILE, source)).toEqual({
			file: FILE,
			jobs: [],
			error: "The file has no `jobs:` mapping.",
		});
	});
});

const COMMENTED = `# Runs on every push.
name: CI

on:
  push:
    branches: [main]   # trunk only

jobs:
  # Fast feedback first.
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5

      - run: pnpm lint   # biome

  test:
    name: "Test"
    runs-on: ubuntu-24.04
    strategy:
      matrix:
        node: [ 22, 24 ]
    steps:
      - run: pnpm test

  release:
    runs-on: ubuntu-24.04
    environment: production
    steps:
      - run: ./release.sh

  mac:
    runs-on: macos-15
    steps:
      - run: swift test
`;

describe("applyWorkflowPlan", () => {
	it("changes the runs-on lines of the ready jobs and no other byte", () => {
		const result = applyWorkflowPlan(FILE, COMMENTED, ["all"]);
		expect(result.changed).toEqual(["lint", "test"]);
		expect(result.refused).toEqual([]);
		expect(changedLines(COMMENTED, result.source)).toEqual([
			"    runs-on: hobo # was ubuntu-latest",
			"    runs-on: hobo # was ubuntu-24.04",
		]);
		expect(result.source).toBe(
			COMMENTED.replace(
				"    runs-on: ubuntu-latest\n",
				"    runs-on: hobo # was ubuntu-latest\n",
			).replace(
				'  test:\n    name: "Test"\n    runs-on: ubuntu-24.04\n',
				'  test:\n    name: "Test"\n    runs-on: hobo # was ubuntu-24.04\n',
			),
		);
	});

	it("leaves the workflow meaning the same apart from runs-on", () => {
		const result = applyWorkflowPlan(FILE, COMMENTED, ["all"]);
		expect(meaningWithout(result.source, result.changed)).toEqual(
			meaningWithout(COMMENTED, result.changed),
		);
		expect(standings(planOf(result.source))).toEqual([
			"lint routed",
			"test routed",
			"release skipped uses_secrets",
			"mac skipped not_linux_x64",
		]);
	});

	it("rewrites only the jobs that were named", () => {
		const result = applyWorkflowPlan(FILE, COMMENTED, ["test"]);
		expect(result.changed).toEqual(["test"]);
		expect(result.refused).toEqual([]);
		expect(changedLines(COMMENTED, result.source)).toEqual([
			"    runs-on: hobo # was ubuntu-24.04",
		]);
		const unselected = (source: string) =>
			planOf(source).jobs.filter((job) => job.job !== "test");
		expect(unselected(result.source)).toEqual(unselected(COMMENTED));
	});

	it("reports changed jobs in file order whatever order they were named in", () => {
		const result = applyWorkflowPlan(FILE, COMMENTED, ["test", "lint", "test"]);
		expect(result.changed).toEqual(["lint", "test"]);
	});

	it("says why a named job was not rewritten", () => {
		const once = applyWorkflowPlan(FILE, COMMENTED, ["lint"]);
		const result = applyWorkflowPlan(FILE, once.source, [
			"missing",
			"lint",
			"release",
			"mac",
			"test",
		]);
		expect(result.changed).toEqual(["test"]);
		expect(result.refused).toEqual([
			{ job: "missing", why: "no such job" },
			{ job: "lint", why: "already routed" },
			{
				job: "release",
				why: `skipped: ${describeWorkflowSkip("uses_secrets")}`,
			},
			{ job: "mac", why: `skipped: ${describeWorkflowSkip("not_linux_x64")}` },
		]);
	});

	it("never refuses the jobs that all leaves out", () => {
		const result = applyWorkflowPlan(FILE, VERDICTS, ["all"]);
		expect(result.changed).toEqual(["build", "one-in-list"]);
		expect(result.refused).toEqual([]);
	});

	it("rewrites a deploy-like job only when such jobs are included", () => {
		const result = applyWorkflowPlan(FILE, COMMENTED, ["all"], {
			includeSecretJobs: true,
		});
		expect(result.changed).toEqual(["lint", "test", "release"]);
		expect(result.refused).toEqual([]);
	});

	it("does nothing the second time", () => {
		const once = applyWorkflowPlan(FILE, COMMENTED, ["all"]);
		const twice = applyWorkflowPlan(FILE, once.source, ["all"]);
		expect(twice).toEqual({ source: once.source, changed: [], refused: [] });
		expect(applyWorkflowPlan(FILE, once.source, ["lint", "test"])).toEqual({
			source: once.source,
			changed: [],
			refused: [
				{ job: "lint", why: "already routed" },
				{ job: "test", why: "already routed" },
			],
		});
	});

	it("returns the text untouched when nothing is selected", () => {
		expect(applyWorkflowPlan(FILE, COMMENTED, [])).toEqual({
			source: COMMENTED,
			changed: [],
			refused: [],
		});
	});

	it("writes the custom fleet label and then reads it as routed", () => {
		const options = { fleetLabel: "acme-fleet" };
		const result = applyWorkflowPlan(FILE, COMMENTED, ["lint"], options);
		expect(changedLines(COMMENTED, result.source)).toEqual([
			"    runs-on: acme-fleet # was ubuntu-latest",
		]);
		expect(standings(planOf(result.source, options))[0]).toBe("lint routed");
	});

	it("quotes a fleet label that YAML would not read as a string", () => {
		const source = oneJob("    runs-on: ubuntu-24.04\n");
		for (const fleetLabel of ["on", "2404", "team: ci"]) {
			const result = applyWorkflowPlan(FILE, source, ["job"], { fleetLabel });
			expect(result.changed).toEqual(["job"]);
			expect(result.source).toBe(
				oneJob(
					`    runs-on: ${JSON.stringify(fleetLabel)} # was ubuntu-24.04\n`,
				),
			);
			expect(onlyJob(result.source, { fleetLabel }).runsOn).toBe(fleetLabel);
		}
	});

	it("keeps CRLF line endings", () => {
		const source = COMMENTED.replaceAll("\n", "\r\n");
		const result = applyWorkflowPlan(FILE, source, ["all"]);
		expect(result.changed).toEqual(["lint", "test"]);
		expect(changedLines(source, result.source)).toEqual([
			"    runs-on: hobo # was ubuntu-latest\r",
			"    runs-on: hobo # was ubuntu-24.04\r",
		]);
		expect(result.source.split("\r\n")).toHaveLength(
			source.split("\r\n").length,
		);
		expect(result.source.replaceAll("\r\n", "")).not.toMatch(/[\r\n]/u);
	});

	it("keeps a trailing comment and adds no second one", () => {
		const source = oneJob(
			"    runs-on: ubuntu-latest   # pinned in the image repo\n    steps: []\n",
		);
		const result = applyWorkflowPlan(FILE, source, ["all"]);
		expect(changedLines(source, result.source)).toEqual([
			"    runs-on: hobo   # pinned in the image repo",
		]);
	});

	it("keeps trailing spaces after the value", () => {
		const source = oneJob("    runs-on: ubuntu-latest  \n    steps: []\n");
		const result = applyWorkflowPlan(FILE, source, ["all"]);
		expect(changedLines(source, result.source)).toEqual([
			"    runs-on: hobo # was ubuntu-latest  ",
		]);
		expect(meaningWithout(result.source, ["job"])).toEqual(
			meaningWithout(source, ["job"]),
		);
	});

	it("rewrites a last line that has no line break", () => {
		const source = oneJob("    runs-on: ubuntu-24.04");
		expect(applyWorkflowPlan(FILE, source, ["all"]).source).toBe(
			oneJob("    runs-on: hobo # was ubuntu-24.04"),
		);
	});

	it.each([
		[
			"double quotes",
			'    runs-on: "ubuntu-latest"\n',
			'    runs-on: "hobo" # was ubuntu-latest\n',
		],
		[
			"single quotes",
			"    runs-on: 'ubuntu-24.04'\n",
			"    runs-on: 'hobo' # was ubuntu-24.04\n",
		],
		[
			"a flow list",
			"    runs-on: [ubuntu-latest]\n",
			"    runs-on: hobo # was ubuntu-latest\n",
		],
		[
			"a flow list with a quoted label",
			'    runs-on: [ "ubuntu-latest" ]   # one label\n',
			"    runs-on: hobo   # one label\n",
		],
		[
			"a flow list over several lines",
			"    runs-on: [\n      ubuntu-latest,\n    ]\n",
			"    runs-on: hobo # was ubuntu-latest\n",
		],
		[
			"a flow list with a comment inside",
			"    runs-on: [ # one for now\n      'ubuntu-latest' ]\n",
			"    runs-on: [ # one for now\n      'hobo' ]\n",
		],
		[
			"a value on the line after the key",
			"    runs-on:\n      ubuntu-latest\n",
			"    runs-on:\n      hobo # was ubuntu-latest\n",
		],
		[
			"a folded block",
			"    runs-on: >-\n      ubuntu-latest\n",
			"    runs-on: hobo # was ubuntu-latest\n",
		],
		[
			"a block list of one",
			"    runs-on:\n      - ubuntu-latest\n",
			"    runs-on: hobo # was ubuntu-latest\n",
		],
		[
			"a block list in the key's column",
			"    runs-on:\n    - ubuntu-latest\n",
			"    runs-on: hobo # was ubuntu-latest\n",
		],
		[
			"a block list whose item has a comment",
			"    runs-on:\n      - ubuntu-latest # for now\n",
			"    runs-on: hobo # for now\n",
		],
		[
			"a block list of one quoted label",
			'    runs-on:\n      - "ubuntu-latest"\n',
			"    runs-on: hobo # was ubuntu-latest\n",
		],
		[
			"a block list under a comment",
			"    runs-on: # one for now\n      - ubuntu-latest\n",
			"    runs-on: # one for now\n      hobo # was ubuntu-latest\n",
		],
		[
			"a block list under a comment, in the key's column",
			"    runs-on: # one for now\n    - ubuntu-latest\n",
			"    runs-on: # one for now\n     hobo # was ubuntu-latest\n",
		],
	])("rewrites %s", (_what, before, after) => {
		const tail = "    steps:\n      - run: pnpm test\n";
		const source = oneJob(`${before}${tail}`);
		const result = applyWorkflowPlan(FILE, source, ["all"]);
		expect(result.refused).toEqual([]);
		expect(result.changed).toEqual(["job"]);
		expect(result.source).toBe(oneJob(`${after}${tail}`));
		expect(onlyJob(result.source)).toMatchObject({
			verdict: "routed",
			runsOn: "hobo",
		});
		expect(meaningWithout(result.source, ["job"])).toEqual(
			meaningWithout(source, ["job"]),
		);
		expect(applyWorkflowPlan(FILE, result.source, ["all"]).source).toBe(
			result.source,
		);
	});

	it("rewrites a job written as a flow mapping without adding a comment", () => {
		const source = `on: push
jobs:
  quick: { runs-on: ubuntu-latest, steps: [{ run: pnpm lint }] }
  spread: {
    runs-on: ubuntu-24.04,
    steps: [{ run: pnpm test }],
  }
`;
		const result = applyWorkflowPlan(FILE, source, ["all"]);
		expect(result.changed).toEqual(["quick", "spread"]);
		expect(changedLines(source, result.source)).toEqual([
			"  quick: { runs-on: hobo, steps: [{ run: pnpm lint }] }",
			"    runs-on: hobo,",
		]);
		expect(meaningWithout(result.source, result.changed)).toEqual(
			meaningWithout(source, result.changed),
		);
	});

	it("keeps every job's meaning across the forms in one file", () => {
		const source = `on:
  pull_request:
  workflow_call:
    inputs:
      size:
        type: string
jobs:
  plain:
    runs-on: ubuntu-latest
    steps: &checkout
      - uses: actions/checkout@v5
  quoted:
    runs-on: "ubuntu-24.04" # quoted on purpose
    steps: *checkout
  listed:
    runs-on:
      - ubuntu-24.04
    needs: [plain, quoted]
    steps: *checkout
  flow:
    runs-on: [ubuntu-latest]
    steps: *checkout
  sized:
    runs-on: \${{ inputs.size }}
    steps: *checkout
  deploy:
    runs-on: ubuntu-24.04
    needs: listed
    permissions:
      id-token: write
    steps: *checkout
`;
		const result = applyWorkflowPlan(FILE, source, ["all"]);
		expect(result.changed).toEqual(["plain", "quoted", "listed", "flow"]);
		expect(result.refused).toEqual([]);
		expect(meaningWithout(result.source, result.changed)).toEqual(
			meaningWithout(source, result.changed),
		);
		expect(planOf(result.source).jobs.map((job) => job.runsOn)).toEqual([
			"hobo",
			"hobo",
			"hobo",
			"hobo",
			"${{ inputs.size }}",
			"ubuntu-24.04",
		]);
		expect(result.source).toContain(
			'    runs-on: "hobo" # quoted on purpose\n',
		);
		expect(result.source).toContain(
			"    runs-on: hobo # was ubuntu-24.04\n    needs: [plain, quoted]\n",
		);
	});

	it("refuses every selected job of a file that does not parse", () => {
		const source = "jobs:\n  build: [\n  test: }\n";
		const error = planWorkflow(FILE, source).error;
		expect(error).toBeDefined();
		expect(applyWorkflowPlan(FILE, source, ["build", "test"])).toEqual({
			source,
			changed: [],
			refused: [
				{ job: "build", why: error },
				{ job: "test", why: error },
			],
		});
		expect(applyWorkflowPlan(FILE, source, ["all"]).refused).toEqual([
			{ job: "all", why: error },
		]);
	});
});

describe("descriptions", () => {
	const wordsBeyond = (text: string, identifier: string) => {
		const own = new Set(identifier.split("_"));
		return text
			.toLowerCase()
			.split(/[^a-z0-9]+/u)
			.filter((word) => word.length > 0 && !own.has(word)).length;
	};

	it.each(WORKFLOW_SKIP_REASONS)("describes the skip reason %s", (reason) => {
		const text = describeWorkflowSkip(reason);
		expect(text).toMatch(/^[A-Z].{20,}\.$/u);
		expect(text).not.toBe(reason);
		expect(wordsBeyond(text, reason)).toBeGreaterThanOrEqual(6);
		expect(text).not.toContain("\n");
	});

	it.each(WORKFLOW_WARNINGS)("describes the warning %s", (warning) => {
		const text = describeWorkflowWarning(warning);
		expect(text).toMatch(/^[A-Z].{20,}\.$/u);
		expect(text).not.toBe(warning);
		expect(wordsBeyond(text, warning)).toBeGreaterThanOrEqual(6);
		expect(text).not.toContain("\n");
	});

	it("gives every reason and warning its own sentence", () => {
		const texts = [
			...WORKFLOW_SKIP_REASONS.map(describeWorkflowSkip),
			...WORKFLOW_WARNINGS.map(describeWorkflowWarning),
		];
		expect(new Set(texts).size).toBe(texts.length);
	});
});

describe("a job that routes other jobs", () => {
	const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    outputs:
      runner: \${{ steps.pick.outputs.runner }}
    steps:
      - id: pick
        run: echo "runner=hobo" >> "$GITHUB_OUTPUT"
  test:
    needs: route
    runs-on: \${{ needs.route.outputs.runner || 'ubuntu-24.04' }}
    steps:
      - run: pnpm test
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
`;

	it("is left where it is, so routing never waits on the fleet", () => {
		const plan = planWorkflow("ci.yml", source);
		expect(plan.jobs.map((job) => [job.job, job.verdict, job.reason])).toEqual([
			["route", "skipped", "routes_jobs"],
			["test", "skipped", "expression"],
			["lint", "ready", undefined],
		]);
		expect(plan.jobs[0]?.warnings).toEqual([]);
	});

	it.each([
		"needs['route'].outputs.runner",
		"needs.route['outputs']['runner']",
		"needs [ 'route' ] . outputs . runner",
	])("recognizes a router referenced as %s", (reference) => {
		const plan = planWorkflow(
			"ci.yml",
			source.replace("needs.route.outputs.runner", reference),
		);
		expect(plan.jobs[0]).toMatchObject({
			job: "route",
			verdict: "skipped",
			reason: "routes_jobs",
		});
		expect(plan.jobs[2]).toMatchObject({ job: "lint", verdict: "ready" });
	});

	it("is refused by name and passed over by all", () => {
		const named = applyWorkflowPlan("ci.yml", source, ["route"]);
		expect(named.changed).toEqual([]);
		expect(named.refused).toEqual([
			{
				job: "route",
				why: expect.stringContaining("decides where the others run"),
			},
		]);
		expect(named.source).toBe(source);
		const all = applyWorkflowPlan("ci.yml", source, ["all"]);
		expect(all.changed).toEqual(["lint"]);
		expect(all.refused).toEqual([]);
		expect(all.source).toContain("  route:\n    runs-on: ubuntu-24.04\n");
	});

	it("recognizes routing through a matrix built from needs outputs", () => {
		const matrix = source.replace(
			"    runs-on: ${{ needs.route.outputs.runner || 'ubuntu-24.04' }}",
			"    strategy:\n      matrix: ${{ fromJSON(needs.route.outputs.matrix) }}\n    runs-on: ${{ matrix.runner }}",
		);
		expect(planWorkflow("ci.yml", matrix).jobs[0]).toMatchObject({
			job: "route",
			verdict: "skipped",
			reason: "routes_jobs",
		});
	});

	it("recognizes routing passed to a reusable workflow", () => {
		const reusable = source.replace(
			"    runs-on: ${{ needs.route.outputs.runner || 'ubuntu-24.04' }}\n    steps:\n      - run: pnpm test",
			"    uses: ./.github/workflows/reusable.yml\n    with:\n      runner: ${{ needs.route.outputs.runner }}",
		);
		expect(planWorkflow("ci.yml", reusable).jobs[0]).toMatchObject({
			job: "route",
			verdict: "skipped",
			reason: "routes_jobs",
		});
	});

	it("recognizes reusable workflow inputs behind a YAML merge", () => {
		const reusable = source.replace(
			"    runs-on: ${{ needs.route.outputs.runner || 'ubuntu-24.04' }}\n    steps:\n      - run: pnpm test",
			"    uses: ./.github/workflows/reusable.yml\n    <<: &call\n      with:\n        runner: ${{ needs.route.outputs.runner }}",
		);
		expect(planWorkflow("ci.yml", reusable).jobs[0]).toMatchObject({
			job: "route",
			verdict: "skipped",
			reason: "routes_jobs",
		});
	});

	it.each([
		[
			"runs-on",
			`  called:
    runs-on: \${{ needs['route.v2'].outputs.runner || 'ubuntu-24.04' }}
    steps:
      - run: pnpm test
`,
		],
		[
			"a reusable workflow input",
			`  called:
    uses: ./.github/workflows/reusable.yml
    with:
      runner: "\${{ needs[\\"route.v2\\"].outputs.runner }}"
`,
		],
		[
			"a strategy matrix",
			`  called:
    strategy:
      matrix: '\${{ fromJSON(needs[''route.v2''].outputs.matrix) }}'
    runs-on: \${{ matrix.runner }}
    steps:
      - run: pnpm test
`,
		],
	])("recognizes router id route.v2, which breaks a backreference, from %s", (_where, caller) => {
		const source = `jobs:
  "route.v2":
    runs-on: ubuntu-24.04
    outputs:
      runner: \${{ steps.pick.outputs.runner }}
    steps:
      - id: pick
        run: echo "runner=hobo" >> "$GITHUB_OUTPUT"
${caller}`;
		expect(planWorkflow("ci.yml", source).jobs[0]).toMatchObject({
			job: "route.v2",
			verdict: "skipped",
			reason: "routes_jobs",
		});
	});

	it("recognizes a quoted job id referenced with YAML-escaped double quotes", () => {
		const source = `jobs:
  "a'b":
    runs-on: ubuntu-24.04
    steps:
      - id: pick
        run: echo "runner=hobo" >> "$GITHUB_OUTPUT"
  called:
    uses: ./.github/workflows/reusable.yml
    with:
      runner: "\${{ needs[\\"a'b\\"].outputs.runner }}"
`;
		expect(planWorkflow("ci.yml", source).jobs[0]).toMatchObject({
			job: "a'b",
			verdict: "skipped",
			reason: "routes_jobs",
		});
	});

	it("recognizes an expression-escaped job id as a router", () => {
		const source = `jobs:
  "a'b":
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ needs['a''b'].outputs.runner }}
    steps:
      - run: pnpm test
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => job.verdict),
		).toEqual(["skipped", "skipped", "ready"]);
		expect(planWorkflow("ci.yml", source).jobs[0]?.reason).toBe("routes_jobs");
	});

	it("does not treat a dotted property path as a dotted job id", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  "route.v2":
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ needs.route.v2.outputs.runner }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [job.job, job.verdict]),
		).toEqual([
			["route", "ready"],
			["route.v2", "ready"],
			["called", "skipped"],
		]);
	});

	it("recognizes a router from a case-insensitive needs output", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ needs.Route.outputs.runner }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["route", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
		]);
	});

	it("recognizes a router from mixed-case needs keywords", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ NEEDS['ROUTE'].RESULT == 'success' && 'ubuntu-24.04' || 'ubuntu-22.04' }}
    steps:
      - run: pnpm test
`;
		expect(planWorkflow("ci.yml", source).jobs[0]).toMatchObject({
			job: "route",
			verdict: "skipped",
			reason: "routes_jobs",
		});
	});

	it("does not treat a case-folded dotted property path as a dotted job id", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  "route.v2":
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ needs.Route.v2.outputs.runner }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [job.job, job.verdict]),
		).toEqual([
			["route", "ready"],
			["route.v2", "ready"],
			["called", "skipped"],
		]);
	});

	it("treats a case-mismatched wildcard needs list as routing only that job", () => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  test:
    needs: Route
    runs-on: \${{ NEEDS.*.OUTPUTS.runner }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["lint", "ready", undefined],
			["route", "skipped", "routes_jobs"],
			["test", "skipped", "expression"],
		]);
	});

	it("recognizes a router whose result selects the runner", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ needs.route.result == 'success' && 'ubuntu-24.04' || 'ubuntu-22.04' }}
    steps:
      - run: pnpm test
`;
		expect(planWorkflow("ci.yml", source).jobs[0]).toMatchObject({
			job: "route",
			verdict: "skipped",
			reason: "routes_jobs",
		});
	});

	it("treats a wildcard needs output as routing only the jobs that are needed", () => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  test:
    needs: route
    runs-on: \${{ needs.*.outputs.runner }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["lint", "ready", undefined],
			["route", "skipped", "routes_jobs"],
			["test", "skipped", "expression"],
		]);
	});

	it("fails closed when a dynamic needs index selects the runner", () => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  test:
    runs-on: \${{ needs[inputs.job].outputs.runner }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [job.job, job.reason]),
		).toEqual([
			["lint", "routes_jobs"],
			["route", "routes_jobs"],
			["test", "expression"],
		]);
	});

	it.each([
		"toJSON(needs.route)",
		"toJSON((needs.route))",
		"TOJSON( ( NEEDS.ROUTE ) )",
		"fromJSON(toJSON(needs.route)).outputs.runner",
		"(needs.route).outputs.runner",
		"(needs['route']).result == 'success' && 'ubuntu-24.04' || 'ubuntu-22.04'",
		"(needs).route.outputs.runner",
		"( needs )['route'].outputs.runner",
		"((needs)).route.result == 'success' && 'ubuntu-24.04' || 'ubuntu-22.04'",
		"!(needs).route.outputs.runner",
		"toJSON((needs).route)",
		"TOJSON( ( ( NEEDS ) . ROUTE ) )",
	])("fails closed when routing reads %s", (expression) => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ ${expression} }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["lint", "ready", undefined],
			["route", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
		]);
	});

	it.each([
		"MATRIX.runner",
		"Matrix['runner']",
		'MaTrIx["runner"]',
		"(MATRIX).runner",
		"toJSON(MATRIX).runner",
	])("fails closed when runs-on reads the matrix context as %s", (expression) => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ ${expression} }}
    strategy:
      matrix: \${{ fromJSON(needs.route.outputs.matrix) }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["lint", "ready", undefined],
			["route", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
		]);
	});

	it("does not treat a strategy as routing when runs-on never reads matrix", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ inputs.runner }}
    strategy:
      matrix: \${{ fromJSON(needs.route.outputs.matrix) }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["route", "ready", undefined],
			["called", "skipped", "expression"],
		]);
	});

	it("fails closed when a matrix is built from toJSON of the router", () => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ matrix.runner }}
    strategy:
      matrix: \${{ fromJSON(toJSON(needs.route)) }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["lint", "ready", undefined],
			["route", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
		]);
	});

	it("fails closed when a reusable workflow input is toJSON of the router", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    uses: ./.github/workflows/reusable.yml
    with:
      runner: \${{ toJSON(needs['route']) }}
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["route", "skipped", "routes_jobs"],
			["called", "skipped", "reusable_workflow"],
			["lint", "ready", undefined],
		]);
	});

	it.each([
		["toJSON(needs)", "route"],
		["toJSON(needs.*)", "route"],
		["TOJSON( ( NEEDS.* ) )", "Route"],
		["(needs.*).outputs.runner", "route"],
		["needs[*].result", "route"],
		["NEEDS[ '*' ].OUTPUTS.runner", "Route"],
	])("fails closed for %s only when needs names that job (%s)", (expression, needed) => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    needs: ${needed}
    runs-on: \${{ ${expression} }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["lint", "ready", undefined],
			["route", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
		]);
	});

	it("does not treat toJSON(needs) as routing when the caller needs nobody", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ toJSON(needs) }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["route", "ready", undefined],
			["called", "skipped", "expression"],
		]);
	});

	it("fails closed when toJSON(needs) follows an opaque needs list", () => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    needs: \${{ inputs.job }}
    runs-on: \${{ toJSON(needs) }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [job.job, job.reason]),
		).toEqual([
			["lint", "routes_jobs"],
			["route", "routes_jobs"],
			["called", "expression"],
		]);
	});

	it.each([
		"needs['route' || inputs.job].outputs.runner",
		"needs[inputs.job || 'route'].outputs.runner",
		"toJSON(needs[inputs.job])",
		"TOJSON( ( NEEDS[format('{0}', inputs.job)] ) )",
		"(needs[inputs.job]).outputs.runner",
		"(needs[inputs.job]).result",
	])("fails closed when the needs index is not a static job id (%s)", (expression) => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ ${expression} }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [job.job, job.reason]),
		).toEqual([
			["lint", "routes_jobs"],
			["route", "routes_jobs"],
			["called", "expression"],
		]);
	});

	it.each([
		"needs.route.*",
		"needs['route'].*",
		"NEEDS.ROUTE['*']",
		"(needs.route).*",
		"toJSON(needs.route.*)",
		"toJSON((needs.route).*)",
		"needs.route[format('{0}', 'outputs')].runner",
		"needs['route'][format('{0}', 'result')]",
		"needs.route[inputs.key || 'outputs']",
		"(needs['route'])[format('{0}', 'outputs')]",
	])("fails closed when %s reads a job property that can carry the runner", (expression) => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ ${expression} }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["lint", "ready", undefined],
			["route", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
		]);
	});

	it.each([
		["needs.*.*", "route"],
		["NEEDS.*['*']", "Route"],
		["(needs.*).*", "route"],
		["needs.*[format('{0}', 'outputs')].runner", "route"],
		["needs[*][format('{0}', 'result')]", "route"],
		["NEEDS[ '*' ][inputs.key]", "Route"],
		["toJSON(needs.*.*)", "route"],
		["TOJSON( ( NEEDS.*['*'] ) )", "Route"],
		["(needs).*.outputs.runner", "route"],
		["(( needs )).*.outputs.runner", "Route"],
		["(needs)[*].result", "route"],
		["(NEEDS)[ '*' ].OUTPUTS.runner", "Route"],
		["toJSON((needs).*)", "route"],
	])("fails closed when %s reads every needed job through a wildcard property (%s)", (expression, needed) => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    needs: ${needed}
    runs-on: \${{ ${expression} }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["lint", "ready", undefined],
			["route", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
		]);
	});

	it.each([
		"needs[inputs.job].*",
		"NEEDS[format('{0}', 'route')]['*']",
		"(needs[inputs.job]).*",
		"needs[inputs.job][format('{0}', 'outputs')].runner",
		"needs[format('{0}', 'route')][format('{0}', 'result')]",
		"toJSON(needs[inputs.job].*)",
		"(needs)[inputs.job].outputs.runner",
		"(( needs ))[format('{0}', 'route')].outputs.runner",
		"toJSON((needs)[inputs.job])",
	])("fails closed when a dynamic needs index reads a runner property (%s)", (expression) => {
		const source = `jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ ${expression} }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [job.job, job.reason]),
		).toEqual([
			["lint", "routes_jobs"],
			["route", "routes_jobs"],
			["called", "expression"],
		]);
	});

	it("does not treat a wildcard star as routing when the caller needs nobody", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ needs.*.* }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["route", "ready", undefined],
			["called", "skipped", "expression"],
		]);
	});

	it("does not treat a grouped read of another job as this job routing", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ (needs).other.outputs.runner }}
    steps:
      - run: pnpm test
  lint:
    runs-on: ubuntu-24.04
    steps:
      - run: pnpm lint
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["route", "ready", undefined],
			["called", "skipped", "expression"],
			["lint", "ready", undefined],
		]);
	});

	it("does not treat toJSON of a different job as this job routing", () => {
		const source = `jobs:
  route:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  other:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ toJSON(needs.other) }}
    steps:
      - run: pnpm test
`;
		expect(
			planWorkflow("ci.yml", source).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["route", "ready", undefined],
			["other", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
		]);
	});

	it("does not mistake a job that only reads its own name for a router", () => {
		const plan = planWorkflow(
			"ci.yml",
			"jobs:\n  a:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: echo needs.a.outputs.x\n",
		);
		expect(plan.jobs[0]?.verdict).toBe("ready");
	});

	it("does not treat a job id that is an invalid regex as a router unless another job reads it", () => {
		const untouched = `jobs:
  "(?":
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  plain:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;
		expect(
			planWorkflow("ci.yml", untouched).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["(?", "ready", undefined],
			["plain", "ready", undefined],
		]);

		const referenced = `jobs:
  "(?":
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
  called:
    runs-on: \${{ needs['(?'].outputs.runner }}
    steps:
      - run: pnpm test
  plain:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;
		expect(
			planWorkflow("ci.yml", referenced).jobs.map((job) => [
				job.job,
				job.verdict,
				job.reason,
			]),
		).toEqual([
			["(?", "skipped", "routes_jobs"],
			["called", "skipped", "expression"],
			["plain", "ready", undefined],
		]);
	});
});
