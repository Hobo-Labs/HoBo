import { createHash } from "node:crypto";
import {
	RELAY_EVALUATOR_FILE,
	RELAY_LABEL,
	RELAY_WORKFLOW_FILE,
} from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { isMap, parse, parseDocument } from "yaml";
import {
	RELAY_JOB_EVALUATOR,
	RELAY_JOB_WORKFLOW,
} from "../src/_generated-assets/relay-job-assets.js";
import {
	applyRelayPlan,
	checkRelayFiles,
	findWorkflowRelays,
	relayFilesFor,
	relayWorkflowText,
	undoRelayPlan,
	type WorkflowRelayOptions,
} from "../src/workflow-relay.js";

const NONE: WorkflowRelayOptions = { includeSecretJobs: false, inputs: [] };

const CI = `name: ci
on: [push, pull_request]
jobs:
  # unit tests
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test
  build:
    needs: test
    runs-on: ubuntu-24.04 # pinned
    steps:
      - run: pnpm build
  mac:
    runs-on: macos-15
    steps:
      - run: swift build
`;

const CI_RELAYED = `name: ci
on: [push, pull_request]
jobs:
  # unit tests
  relay-test:
    uses: ./.github/workflows/hobo-relay.yml
    permissions:
      actions: read
      contents: read
    with:
      github: ubuntu-latest
  test:
    needs: relay-test
    runs-on: \${{ needs.relay-test.outputs.runner }}
    steps:
      - uses: actions/checkout@v4
      - run: pnpm test
  relay-build:
    uses: ./.github/workflows/hobo-relay.yml
    permissions:
      actions: read
      contents: read
    with:
      github: ubuntu-24.04
  build:
    needs: [relay-build, test]
    runs-on: \${{ needs.relay-build.outputs.runner }} # pinned
    steps:
      - run: pnpm build
  mac:
    runs-on: macos-15
    steps:
      - run: swift build
`;

const FORMS = {
	"flow needs": `jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  b:
    needs: [a]
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
`,
	"empty flow needs": `jobs:
  b:
    needs: [ ]
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
`,
	"block needs last in the job": `jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  b:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
    needs:
      - a
  c:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
`,
	"block needs at the end of the file": `jobs:
  a:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  b:
    runs-on: ubuntu-latest
    needs:
      - a`,
	"quoted needs and runs-on": `jobs:
  a:
    runs-on: 'ubuntu-latest'
    steps: [{ run: "true" }]
  b:
    needs: "a"
    runs-on: "ubuntu-22.04"
    steps: [{ run: "true" }]
`,
	"runs-on as a list": `jobs:
  a:
    runs-on: [ubuntu-latest]
    steps: [{ run: "true" }]
  b:
    runs-on:
      - ubuntu-24.04
    steps: [{ run: "true" }]
`,
	"four-space indentation": `jobs:
    a:
        runs-on: ubuntu-latest
        steps:
            - run: "true"
`,
	"a matrix job": `jobs:
  test:
    strategy:
      matrix:
        node: [20, 22, 24]
    runs-on: ubuntu-24.04
    steps:
      - run: node --version
`,
	"windows line endings":
		'jobs:\r\n  a:\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - run: "true"\r\n  b:\r\n    needs: a\r\n    runs-on: ubuntu-latest\r\n    steps:\r\n      - run: "true"\r\n',
};

type Job = Readonly<{
	needs?: string | readonly string[];
	"runs-on"?: string | readonly string[];
	uses?: string;
	with?: Readonly<Record<string, string>>;
}>;

function jobsOf(source: string): Readonly<Record<string, Job>> {
	const workflow: { jobs: Record<string, Job> } = parse(source);
	return workflow.jobs;
}

function needsOf(job: Job | undefined): readonly string[] {
	const needs = job?.needs;
	if (needs === undefined) return [];
	return Array.isArray(needs) ? needs : [String(needs)];
}

describe("applyRelayPlan (S03)", () => {
	it("puts each chosen job behind its own relay, as bytes spliced into the file", () => {
		const result = applyRelayPlan("ci.yml", CI, ["all"], NONE);
		expect(result.changed).toEqual(["test", "build"]);
		expect(result.refused).toEqual([]);
		expect(result.source).toBe(CI_RELAYED);
	});

	it("undoes to the original bytes, and applies again to the same bytes", () => {
		const applied = applyRelayPlan("ci.yml", CI, ["all"], NONE).source;
		const undone = undoRelayPlan(applied);
		expect(undone.restored).toEqual(["test", "build"]);
		expect(undone.refused).toEqual([]);
		expect(undone.source).toBe(CI);
		expect(applyRelayPlan("ci.yml", undone.source, ["all"], NONE).source).toBe(
			applied,
		);
	});

	it.each(Object.entries(FORMS))("round-trips %s", (_name, source) => {
		const applied = applyRelayPlan("w.yml", source, ["all"], NONE);
		expect(applied.refused).toEqual([]);
		expect(applied.changed.length).toBeGreaterThan(0);
		expect(parseDocument(applied.source).errors).toEqual([]);
		const jobs = jobsOf(applied.source);
		for (const id of applied.changed) {
			const relay = `relay-${id}`;
			expect(jobs[relay]?.uses).toBe(`./${RELAY_WORKFLOW_FILE}`);
			expect(needsOf(jobs[id])).toContain(relay);
			const runsOn = jobs[id]?.["runs-on"];
			expect(Array.isArray(runsOn) ? runsOn[0] : runsOn).toBe(
				`\${{ needs.${relay}.outputs.runner }}`,
			);
		}
		const undone = undoRelayPlan(applied.source);
		expect(undone.refused).toEqual([]);
		expect(undone.source).toBe(source);
		expect(applyRelayPlan("w.yml", undone.source, ["all"], NONE).source).toBe(
			applied.source,
		);
	});

	it("keeps the needs a job had and the label it had as the relay's github input", () => {
		const applied = applyRelayPlan("w.yml", FORMS["flow needs"], ["b"], NONE);
		const jobs = jobsOf(applied.source);
		expect(needsOf(jobs.b)).toEqual(["a", "relay-b"]);
		expect(jobs["relay-b"]?.with).toEqual({ github: "ubuntu-latest" });
		expect(jobs.a?.["runs-on"]).toBe("ubuntu-latest");
	});

	it("gives a matrix job one relay for every leg", () => {
		const applied = applyRelayPlan(
			"w.yml",
			FORMS["a matrix job"],
			["test"],
			NONE,
		);
		const jobs = jobsOf(applied.source);
		expect(Object.keys(jobs)).toEqual(["relay-test", "test"]);
		expect(jobs.test?.["runs-on"]).toBe(
			"${{ needs.relay-test.outputs.runner }}",
		);
	});

	it("writes the runner types given as inputs, in input order, with github always the job's label", () => {
		const applied = applyRelayPlan("ci.yml", CI, ["test"], {
			includeSecretJobs: false,
			inputs: [
				{ name: "depot", value: "auto" },
				{ name: "machine", value: "self-hosted, linux" },
				{ name: "github", value: "ignored" },
			],
		});
		expect(applied.source).toContain(
			"    with:\n      machine: self-hosted, linux\n      github: ubuntu-latest\n      depot: auto\n  test:\n",
		);
		expect(jobsOf(applied.source)["relay-test"]?.with).toEqual({
			machine: "self-hosted, linux",
			github: "ubuntu-latest",
			depot: "auto",
		});
		expect(undoRelayPlan(applied.source).source).toBe(CI);
	});

	it("refuses jobs that are not ready, missing, or already behind a relay", () => {
		const result = applyRelayPlan("ci.yml", CI, ["mac", "nope"], NONE);
		expect(result.changed).toEqual([]);
		expect(result.refused).toEqual([
			{ job: "mac", why: "it is not a job that can move behind a relay" },
			{ job: "nope", why: "no such job" },
		]);
		const again = applyRelayPlan("ci.yml", CI_RELAYED, ["all"], NONE);
		expect(again.changed).toEqual([]);
		expect(again.source).toBe(CI_RELAYED);
	});

	it("leaves deploy-like jobs alone unless asked", () => {
		const deploy = `jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - run: ./deploy.sh
`;
		expect(applyRelayPlan("d.yml", deploy, ["all"], NONE).changed).toEqual([]);
		const asked = applyRelayPlan("d.yml", deploy, ["deploy"], {
			includeSecretJobs: true,
			inputs: [],
		});
		expect(asked.changed).toEqual(["deploy"]);
		expect(undoRelayPlan(asked.source).source).toBe(deploy);
	});

	it("refuses an edit it could not undo byte for byte, and jobs written so it cannot place one", () => {
		const quotedFlow = `jobs:
  a:
    runs-on: ["ubuntu-latest"]
    steps: [{ run: "true" }]
`;
		expect(applyRelayPlan("w.yml", quotedFlow, ["a"], NONE).refused).toEqual([
			{
				job: "a",
				why: "the edit could not be undone byte for byte later; change runs-on to one label first",
			},
		]);
		const flowJob = `jobs:
  a: { runs-on: ubuntu-latest, steps: [{ run: "true" }] }
`;
		expect(
			applyRelayPlan("w.yml", flowJob, ["a"], NONE).refused[0]?.why,
		).toMatch(/could not be located/u);
		const taken = `jobs:
  relay-a:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
  a:
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
`;
		expect(applyRelayPlan("w.yml", taken, ["a"], NONE).refused).toEqual([
			{ job: "a", why: "a job named relay-a already exists" },
		]);
		const anchored = `jobs:
  a: &job
    runs-on: ubuntu-latest
    steps: [{ run: "true" }]
`;
		expect(
			applyRelayPlan("w.yml", anchored, ["a"], NONE).refused[0]?.why,
		).toMatch(/anchor/u);
	});

	it("refuses every job in a file that is not valid YAML", () => {
		const result = applyRelayPlan("w.yml", "jobs: [", ["a"], NONE);
		expect(result.changed).toEqual([]);
		expect(result.refused[0]?.job).toBe("a");
	});
});

describe("undoRelayPlan (S09)", () => {
	it("refuses a relay edited since it was written, naming the lines", () => {
		const edited = CI_RELAYED.replace(
			"      github: ubuntu-latest\n",
			"      github: ubuntu-latest\n      # added by hand\n",
		);
		const undone = undoRelayPlan(edited);
		expect(undone.restored).toEqual(["build"]);
		expect(undone.refused).toEqual([
			{
				job: "test",
				why: "the relay relay-test changed since hobo ci init wrote it",
				lines: [5, 12],
			},
		]);
		expect(findWorkflowRelays(undone.source).map((relay) => relay.job)).toEqual(
			["test"],
		);
	});

	it("refuses a job whose runs-on no longer reads the relay", () => {
		const edited = CI_RELAYED.replace(
			"runs-on: ${{ needs.relay-build.outputs.runner }} # pinned",
			"runs-on: ubuntu-24.04",
		);
		const undone = undoRelayPlan(edited, ["build"]);
		expect(undone.restored).toEqual([]);
		expect(undone.refused).toEqual([
			{
				job: "build",
				why: "the runs-on of build no longer reads the runner from relay-build",
				lines: [27, 27],
			},
		]);
		expect(undone.source).toBe(edited);
	});

	it("refuses a relay that no longer sits right above its job", () => {
		const moved = `jobs:
  relay-a:
    uses: ./.github/workflows/hobo-relay.yml
    permissions:
      actions: read
      contents: read
    with:
      github: ubuntu-latest
  other:
    runs-on: ubuntu-latest
  a:
    needs: relay-a
    runs-on: \${{ needs.relay-a.outputs.runner }}
`;
		expect(undoRelayPlan(moved).refused).toEqual([
			{
				job: "a",
				why: "the job a no longer follows its relay relay-a",
				lines: [2, 2],
			},
		]);
	});

	it("restores only the jobs asked for", () => {
		const undone = undoRelayPlan(CI_RELAYED, ["build"]);
		expect(undone.restored).toEqual(["build"]);
		expect(findWorkflowRelays(undone.source)).toEqual([
			{ relay: "relay-test", job: "test", github: "ubuntu-latest" },
		]);
		expect(undoRelayPlan(undone.source).source).toBe(CI);
	});

	it("leaves a file with no relay as it is", () => {
		expect(undoRelayPlan(CI)).toEqual({
			source: CI,
			restored: [],
			refused: [],
		});
		expect(undoRelayPlan("not: [yaml").source).toBe("not: [yaml");
	});
});

describe("relay files", () => {
	const sha = (text: string) =>
		createHash("sha256").update(text, "utf8").digest("hex");

	it("writes the generated workflow and evaluator in job mode, and only the workflow in relay mode", () => {
		expect(relayFilesFor("job")).toEqual([
			{ path: RELAY_WORKFLOW_FILE, text: RELAY_JOB_WORKFLOW },
			{ path: RELAY_EVALUATOR_FILE, text: RELAY_JOB_EVALUATOR },
		]);
		expect(relayFilesFor("relay").map((file) => file.path)).toEqual([
			RELAY_WORKFLOW_FILE,
		]);
	});

	it("asks for the relay label in relay mode and keeps every input and output", () => {
		const job = parse(RELAY_JOB_WORKFLOW);
		const relay = parse(relayWorkflowText("relay"));
		expect(relay.jobs.relay["runs-on"]).toBe(RELAY_LABEL);
		expect(job.jobs.relay["runs-on"]).toBe("ubuntu-24.04");
		expect(relay.on).toEqual(job.on);
		expect(relay.permissions).toEqual(job.permissions);
		expect(relay.jobs.relay.outputs).toEqual(job.jobs.relay.outputs);
		expect(relayWorkflowText("relay", "my-relay")).toContain(
			"\n    runs-on: my-relay\n",
		);
		const doc = parseDocument(relayWorkflowText("relay"));
		expect(doc.errors).toEqual([]);
		expect(isMap(doc.contents)).toBe(true);
	});

	it("finds current files in either mode", () => {
		const job = checkRelayFiles({
			workflow: RELAY_JOB_WORKFLOW,
			evaluator: RELAY_JOB_EVALUATOR,
		});
		expect(job.mode).toBe("job");
		expect(job.current).toBe(true);
		const relay = checkRelayFiles({
			workflow: relayWorkflowText("relay"),
			evaluator: undefined,
		});
		expect(relay.mode).toBe("relay");
		expect(relay.current).toBe(true);
		expect(relay.files.map((file) => file.state)).toEqual([
			"current",
			"not_needed",
		]);
	});

	it("says which file is missing, stale or edited", () => {
		expect(
			checkRelayFiles({ workflow: undefined, evaluator: undefined }).files.map(
				(file) => file.state,
			),
		).toEqual(["missing", "missing"]);
		const older = RELAY_JOB_WORKFLOW.replace(
			"timeout-minutes: 3",
			"timeout-minutes: 4",
		);
		expect(
			checkRelayFiles({ workflow: older, evaluator: RELAY_JOB_EVALUATOR }),
		).toMatchObject({ mode: "job", current: false });
		const end = "// --- end of header ---\n";
		const at = RELAY_JOB_EVALUATOR.indexOf(end) + end.length;
		const head = RELAY_JOB_EVALUATOR.slice(0, at);
		const body = RELAY_JOB_EVALUATOR.slice(at);
		const edited = `${head}${body}// one more line\n`;
		expect(
			checkRelayFiles({ workflow: RELAY_JOB_WORKFLOW, evaluator: edited })
				.files[1]?.state,
		).toBe("edited");
		const otherBody = `${body}// another build\n`;
		const otherHead = head.replace(
			/sha256: [0-9a-f]{64}/u,
			`sha256: ${sha(otherBody)}`,
		);
		const stale = checkRelayFiles({
			workflow: RELAY_JOB_WORKFLOW,
			evaluator: `${otherHead}${otherBody}`,
		});
		expect(stale.files[1]?.state).toBe("stale");
		expect(stale.current).toBe(false);
		expect(
			checkRelayFiles({
				workflow: RELAY_JOB_WORKFLOW,
				evaluator: "export {};\n",
			}).files[1]?.state,
		).toBe("edited");
	});

	it("counts as a relay only a relay- job that calls the relay workflow", () => {
		const lookalike = `jobs:
  relay-a:
    uses: ./.github/workflows/other.yml
  a:
    runs-on: ubuntu-latest
`;
		expect(findWorkflowRelays(lookalike)).toEqual([]);
		expect(findWorkflowRelays(CI)).toEqual([]);
		expect(findWorkflowRelays(CI_RELAYED).map((relay) => relay.relay)).toEqual([
			"relay-test",
			"relay-build",
		]);
	});
});
