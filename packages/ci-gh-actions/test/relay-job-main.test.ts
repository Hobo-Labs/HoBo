/**
 * The relay job's job mode (ADR-0183): the entry the vendored evaluator runs,
 * its outputs and journal, and the gauntlet cases it owns (R04, R05, R11,
 * R14, R15, C03) played against the GitHub simulator. In each scenario a
 * GitHub-hosted runner takes the relay job, the entry answers it with the
 * simulator as GitHub, and the job is completed with the outputs and
 * annotations the entry wrote, so GitHub's own rules decide what runs next.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromJsonString } from "@bufbuild/protobuf";
import { DEFAULT_RUNNER_ORDER, RunnerRouteEventSchema } from "@hobo/ci";
import {
	routeJournalConformance,
	runnerOrderSourceConformance,
} from "@hobo/ci/runner-order/testing";
import { describe, expect, it } from "vitest";
import {
	CheckoutRunnerOrderSource,
	parseRelayJobArguments,
	type RelayJobArguments,
	type RelayJobRun,
	runRelayJob,
	runRelayJobCli,
} from "../src/relay-job/main.js";
import {
	escapeCommandData,
	escapeCommandProperty,
	NoticeRouteJournal,
	outputFileText,
	RELAY_ANSWER_ANNOTATION_TITLE,
	RELAY_DECISION_NOTICE_TITLE,
	workflowCommand,
} from "../src/relay-job/outputs.js";
import { GithubSimulator } from "./support/github-simulator/index.js";
import type { SimulatedJob } from "./support/github-simulator-port.js";

const REPO = "octo/app";
const HOSTED = "ubuntu-24.04";
const HOSTED_RUNNER = "GitHub Actions 1";
const NEEDS_RUNNER = "${{ needs.relay.outputs.runner }}";
const DELIMITER = "hobo_relay_0123456789abcdef";
const MINUTE = 60_000;

/** The outputs GitHub reads back from `GITHUB_OUTPUT` text, as its runner parses it. */
function readOutputFile(text: string): Map<string, string> {
	const outputs = new Map<string, string>();
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const match = /^([a-z]+)<<(\S+)$/u.exec(lines[index] ?? "");
		if (!match?.[1] || !match[2]) continue;
		const value: string[] = [];
		for (index += 1; lines[index] !== match[2]; index += 1)
			value.push(lines[index] ?? "");
		outputs.set(match[1], value.join("\n"));
	}
	return outputs;
}

/** A workflow command printed by the entry, read back. */
type Printed = Readonly<{ level: string; title: string; message: string }>;
function readCommands(lines: readonly string[]): Printed[] {
	return lines.flatMap((line) => {
		const match = /^::(error|warning|notice) title=([^:]*)::(.*)$/u.exec(line);
		return match?.[1] && match[2] !== undefined && match[3] !== undefined
			? [
					{
						level: match[1],
						title: decodeURIComponent(match[2]),
						message: decodeURIComponent(match[3]),
					},
				]
			: [];
	});
}

type Answered = Readonly<{
	run: RelayJobRun;
	outputs: Map<string, string>;
	printed: Printed[];
	relay: SimulatedJob;
}>;

/**
 * Run a workflow's relay job in job mode: a GitHub-hosted runner takes it,
 * the entry answers with `github` as GitHub, and the job is completed with
 * what the entry wrote.
 */
async function answerRelay(
	github: GithubSimulator,
	relay: SimulatedJob,
	init: Readonly<{
		project?: string;
		inputs: readonly (readonly [string, string])[];
		privacy?: "true" | "false" | "unknown";
		fork?: boolean;
		event?: string;
	}>,
): Promise<Answered> {
	if (!github.runners().some((runner) => runner.name === HOSTED_RUNNER))
		github.registerRunner({ name: HOSTED_RUNNER, labels: [HOSTED] });
	const claimed = github.claim(HOSTED_RUNNER);
	expect(claimed?.id).toBe(relay.id);
	const parsed = parseRelayJobArguments([
		...init.inputs.flatMap(([name, value]) => [`--${name}`, value]),
		"--repository",
		relay.repository,
		"--run-id",
		String(relay.runId),
		"--run-attempt",
		String(relay.runAttempt),
		"--job",
		relay.name,
		"--event",
		init.event ?? "push",
		"--actor-id",
		"42",
		"--private",
		init.privacy ?? "true",
		"--fork",
		init.fork ? "true" : "false",
		"--workflow-ref",
		`${relay.repository}/.github/workflows/ci.yml@refs/heads/main`,
	]);
	if (!parsed.ok) throw new Error(parsed.problem);
	const lines: string[] = [];
	let outputText = "";
	const run = await runRelayJob(parsed.value, {
		token: "ghs_job_token",
		apiUrl: github.baseUrl,
		fetch: github.fetch,
		readProjectFile: async () => init.project,
		nowMs: github.nowMs(),
		print: (line) => lines.push(line),
		writeOutputs: async (text) => {
			outputText += text;
		},
		delimiter: DELIMITER,
	});
	const outputs = readOutputFile(outputText);
	const printed = readCommands(lines);
	const completed = github.complete(relay.id, {
		conclusion: run.exitCode === 0 ? "success" : "failure",
		outputs,
		annotations: printed
			.filter((line) => line.title === RELAY_ANSWER_ANNOTATION_TITLE)
			.map((line) => ({
				level: line.level === "error" ? "failure" : "notice",
				message: line.message,
			})),
	});
	return { run, outputs, printed, relay: completed };
}

type QueuedWorkflow = Readonly<{ relay: SimulatedJob; runId: number }>;

/** A workflow run: the relay job and the jobs that need it, on its runner. */
function queueWorkflow(
	github: GithubSimulator,
	behind: readonly string[] = ["build"],
): QueuedWorkflow {
	const relay = github.queueJob({
		repository: REPO,
		name: "relay",
		labels: [HOSTED],
	});
	for (const name of behind)
		github.queueJob({
			repository: REPO,
			name,
			runId: relay.runId,
			labels: [NEEDS_RUNNER],
			needs: ["relay"],
		});
	return { relay, runId: relay.runId };
}

function jobNamed(github: GithubSimulator, runId: number, name: string) {
	const job = github
		.jobs()
		.find((entry) => entry.runId === runId && entry.name === name);
	if (!job) throw new Error(`no job ${name} in run ${runId}`);
	return job;
}

function order(steps: readonly string[]): string {
	return JSON.stringify({
		runnerOrder: { steps: steps.map((key) => ({ key })) },
	});
}

describe("relay job arguments", () => {
	const context = [
		"--repository",
		REPO,
		"--run-id",
		"77",
		"--job",
		"relay",
		"--event",
		"pull_request",
	];

	it("reads the relay inputs in their own order, leaving empty ones out", () => {
		const parsed = parseRelayJobArguments([
			"--github",
			HOSTED,
			"--fleet",
			"",
			"--machine",
			" studio, gpu ",
			...context,
		]);
		expect(parsed.ok).toBe(true);
		const args = parsed.ok ? parsed.value : undefined;
		expect(args?.inputs).toEqual([
			["machine", "studio, gpu"],
			["github", HOSTED],
		]);
		expect(args?.jobId).toBe("77-1-relay");
		expect(args?.runAttempt).toBe(1);
		expect(args?.private).toBe("unknown");
		expect(args?.fork).toBe(false);
	});

	it.each([
		[["--colour", "red", ...context], 'unknown argument "--colour"'],
		[["--github", HOSTED, "--github", HOSTED, ...context], "given twice"],
		[[...context, "--size"], "has no value"],
		[["--repository", REPO, "--run-id", "77", "--job", "relay"], "--event"],
		[[...context, "--run-id"], "has no value"],
		[[...context, "--private", "maybe"], "--private"],
		[[...context, "--fork", "yes"], "--fork"],
	])("refuses %j", (argv, problem) => {
		const parsed = parseRelayJobArguments(argv);
		expect(parsed.ok).toBe(false);
		expect(parsed.ok ? "" : parsed.problem).toContain(problem);
	});

	it("refuses a run id that is not one", () => {
		const parsed = parseRelayJobArguments([
			"--repository",
			REPO,
			"--run-id",
			"7e3",
			"--job",
			"relay",
			"--event",
			"push",
		]);
		expect(parsed.ok ? "" : parsed.problem).toBe("--run-id is a run id");
	});
});

describe("relay job outputs", () => {
	it("escapes workflow commands as the runner unescapes them", () => {
		expect(escapeCommandData("50%\r\nnext")).toBe("50%25%0D%0Anext");
		expect(escapeCommandProperty("a:b,c")).toBe("a%3Ab%2Cc");
		expect(workflowCommand("error", "t:1", "line\nline")).toBe(
			"::error title=t%3A1::line%0Aline",
		);
	});

	it("writes outputs in GitHub's multi-line form", () => {
		const text = outputFileText(
			[
				{ name: "runner", value: HOSTED },
				{ name: "reason", value: "two\nlines" },
			],
			DELIMITER,
		);
		expect(readOutputFile(text)).toEqual(
			new Map([
				["runner", HOSTED],
				["reason", "two\nlines"],
			]),
		);
		expect(() =>
			outputFileText([{ name: "runner", value: DELIMITER }], DELIMITER),
		).toThrow(/delimiter/u);
		expect(() => outputFileText([], "short")).toThrow(/16/u);
	});

	it("keeps the route journal's rules and prints each decision once", async () => {
		await routeJournalConformance(() => new NoticeRouteJournal(() => {}));
		const lines: string[] = [];
		await routeJournalConformance(
			() => new NoticeRouteJournal((line) => lines.push(line)),
		);
		const notices = readCommands(lines);
		expect(
			notices.every((line) => line.title === RELAY_DECISION_NOTICE_TITLE),
		).toBe(true);
		// Four decisions are recorded, one of them a redelivery that is kept once.
		expect(notices).toHaveLength(3);
		const event = fromJsonString(
			RunnerRouteEventSchema,
			notices[0]?.message ?? "",
		);
		expect(event.type).toBe("runner.route.Decided");
	});
});

describe("the committed runner order in the checkout", () => {
	it("keeps the runner order source's rules", async () => {
		await runnerOrderSourceConformance(
			(orders) =>
				new CheckoutRunnerOrderSource(async (repository) => {
					const json = orders.get(repository.toLowerCase());
					return json === undefined ? undefined : `{"runnerOrder":${json}}`;
				}),
		);
	});

	it("names the file in a broken order's sentence and reads no file as the default", async () => {
		const broken = new CheckoutRunnerOrderSource(async () => "not json");
		expect((await broken.order(REPO, undefined)).problem).toBe(
			".hobo/ci.json: the project file is not JSON",
		);
		const none = new CheckoutRunnerOrderSource(async () => undefined);
		const lookup = await none.order(REPO, undefined);
		expect(lookup).toEqual({ order: DEFAULT_RUNNER_ORDER, problem: "" });
	});
});

describe("the relay job in job mode, against the GitHub simulator", () => {
	it("R04 fails with the one-sentence reason when nothing fits, and GitHub skips the job behind it", async () => {
		const github = new GithubSimulator();
		const { relay, runId } = queueWorkflow(github);
		const answered = await answerRelay(github, relay, {
			project: order(["machine"]),
			inputs: [["machine", "studio"]],
		});
		expect(answered.run.exitCode).toBe(1);
		expect(answered.outputs.get("outcome")).toBe("none");
		expect(answered.outputs.get("runner")).toBe("");
		const reason = answered.outputs.get("reason") ?? "";
		expect(reason).toMatch(/^[^\n]+\.$/u);
		const errors = answered.printed.filter((line) => line.level === "error");
		expect(errors.map((line) => line.message)).toEqual([reason]);
		expect(answered.relay.conclusion).toBe("failure");
		expect(answered.relay.annotations).toEqual([reason]);
		const build = jobNamed(github, runId, "build");
		expect(build.status).toBe("completed");
		expect(build.conclusion).toBe("skipped");
		expect(build.runnerName).toBeUndefined();
	});

	it("R05 waits on the busy machine's label, and a cancelled run leaves the queue holding no slot", async () => {
		const github = new GithubSimulator();
		github.registerRunner({ name: "studio-1", labels: ["studio"] });
		// The machine took a job a minute ago and is still on it; another job waits for it.
		const earlier = github.queueJob({
			repository: REPO,
			name: "probe",
			labels: ["studio"],
		});
		expect(github.claim("studio-1")?.id).toBe(earlier.id);
		github.queueJob({ repository: REPO, name: "test", labels: ["studio"] });
		github.advance(2 * MINUTE);
		const { relay, runId } = queueWorkflow(github);
		const answered = await answerRelay(github, relay, {
			inputs: [["machine", "studio"]],
		});
		expect(answered.run.exitCode).toBe(0);
		expect(answered.outputs.get("outcome")).toBe("waiting");
		expect(answered.outputs.get("step")).toBe("machine");
		expect(answered.outputs.get("runner")).toBe("studio");
		const build = jobNamed(github, runId, "build");
		expect(build.status).toBe("queued");
		expect(build.labels).toEqual(["studio"]);
		github.cancelRun(runId);
		const cancelled = jobNamed(github, runId, "build");
		expect(cancelled.status).toBe("completed");
		expect(cancelled.conclusion).toBe("cancelled");
		expect(cancelled.runnerName).toBeUndefined();
		const studio = github
			.runners()
			.find((runner) => runner.name === "studio-1");
		expect(studio?.busy).toBe(true);
		expect(
			github
				.jobs()
				.filter((job) => job.runnerName === "studio-1")
				.map((job) => job.id),
		).toEqual([earlier.id]);
	});

	it("R11 tries the job's own first runner type at its own size", async () => {
		const github = new GithubSimulator();
		const { relay, runId } = queueWorkflow(github);
		const answered = await answerRelay(github, relay, {
			project: order(["github", "depot"]),
			inputs: [
				["github", HOSTED],
				["depot", "auto"],
				["size", "8"],
				["first", "depot"],
			],
		});
		expect(answered.run.exitCode).toBe(0);
		expect(answered.outputs.get("step")).toBe("depot");
		expect(answered.outputs.get("runner")).toBe("depot-ubuntu-24.04-8");
		expect(jobNamed(github, runId, "build").labels).toEqual([
			"depot-ubuntu-24.04-8",
		]);
		// Without its own choices the same job takes the committed order's first step.
		const plain = new GithubSimulator();
		const second = queueWorkflow(plain);
		const unchosen = await answerRelay(plain, second.relay, {
			project: order(["github", "depot"]),
			inputs: [
				["github", HOSTED],
				["depot", "auto"],
			],
		});
		expect(unchosen.outputs.get("runner")).toBe(HOSTED);
	});

	it("R14 routes a three-leg matrix with one relay output", async () => {
		const github = new GithubSimulator();
		const legs = ["test (1)", "test (2)", "test (3)"];
		const { relay, runId } = queueWorkflow(github, legs);
		const answered = await answerRelay(github, relay, {
			inputs: [["github", HOSTED]],
		});
		expect(answered.outputs.get("runner")).toBe(HOSTED);
		for (const leg of legs)
			expect(jobNamed(github, runId, leg).labels).toEqual([HOSTED]);
		// GitHub gives each leg its own hosted runner.
		const runners = [HOSTED_RUNNER, "GitHub Actions 2", "GitHub Actions 3"];
		for (const name of runners.slice(1))
			github.registerRunner({ name, labels: [HOSTED] });
		const ran = runners.map((name) => github.claim(name));
		expect(ran.map((job) => job?.name).sort()).toEqual([...legs].sort());
		for (const job of ran)
			if (job) github.complete(job.id, { conclusion: "success" });
		for (const leg of legs) {
			const done = jobNamed(github, runId, leg);
			expect(done.conclusion).toBe("success");
			expect(runners).toContain(done.runnerName);
		}
	});

	it("R15 routes a job with no relay reachable", async () => {
		const github = new GithubSimulator();
		const { relay, runId } = queueWorkflow(github);
		// No relay is deployed: every webhook GitHub sends goes unanswered.
		const responses = await github.deliver(
			async () => new Response("no relay here", { status: 503 }),
		);
		expect(responses.every((response) => response.status === 503)).toBe(true);
		const answered = await answerRelay(github, relay, {
			project: order(["fleet", "machine", "github"]),
			inputs: [
				["fleet", "auto"],
				["machine", "auto"],
				["github", HOSTED],
			],
		});
		expect(answered.outputs.get("outcome")).toBe("routed");
		expect(answered.outputs.get("runner")).toBe(HOSTED);
		const build = github.claim(HOSTED_RUNNER);
		expect(build?.name).toBe("build");
		expect(build?.runId).toBe(runId);
		// It read GitHub with the job token and asked nothing of a runner service.
		const asked = github.requests();
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.every((request) => request.method === "GET")).toBe(true);
		expect(asked.every((request) => request.authorized)).toBe(true);
		expect(asked.some((request) => request.area === "runner-service")).toBe(
			false,
		);
		const notice = answered.printed.find(
			(line) => line.title === RELAY_DECISION_NOTICE_TITLE,
		);
		const event = fromJsonString(RunnerRouteEventSchema, notice?.message ?? "");
		expect(event.mode).toBe("job");
		expect(event.decision?.runner).toBe(HOSTED);
	});

	it("C03 fails the relay job with the parser's sentence when the committed order is broken", async () => {
		const github = new GithubSimulator();
		const { relay, runId } = queueWorkflow(github);
		const answered = await answerRelay(github, relay, {
			project: JSON.stringify({ runnerOrder: { steps: [] } }),
			inputs: [["github", HOSTED]],
		});
		expect(answered.run.exitCode).toBe(1);
		const reason = answered.outputs.get("reason");
		expect(reason).toBe(
			".hobo/ci.json: invalid runner order: a runner order needs at least one step",
		);
		expect(answered.relay.annotations).toEqual([reason]);
		expect(jobNamed(github, runId, "build").conclusion).toBe("skipped");
		// A broken order is refused before GitHub is read.
		expect(github.requests()).toEqual([]);
	});

	it("reads whether the repository is private when the event did not say, and keeps a public one off machines", async () => {
		const github = new GithubSimulator();
		github.addRepository(REPO, false);
		github.registerRunner({ name: "studio-1", labels: ["studio"] });
		const { relay } = queueWorkflow(github);
		const answered = await answerRelay(github, relay, {
			privacy: "unknown",
			inputs: [
				["machine", "studio"],
				["github", HOSTED],
			],
		});
		expect(answered.outputs.get("runner")).toBe(HOSTED);
		expect(github.requests()[0]?.path).toBe(`/repos/${REPO}`);
		const notice = answered.printed.find(
			(line) => line.title === RELAY_DECISION_NOTICE_TITLE,
		);
		const event = fromJsonString(RunnerRouteEventSchema, notice?.message ?? "");
		expect(event.request?.private).toBe(false);
		expect(
			event.decision?.skipped.find((skip) => skip.key === "machine")?.reason,
		).toBe("public_repository");
	});

	it("walks the order with nothing measured when GitHub cannot be read", async () => {
		const lines: string[] = [];
		const args: RelayJobArguments = {
			inputs: [["github", HOSTED]],
			repository: REPO,
			runId: 5,
			runAttempt: 1,
			job: "relay",
			jobId: "5-1-relay",
			event: "push",
			actorId: "42",
			triggeringActorId: "42",
			private: "true",
			fork: false,
			workflowRef: "",
		};
		const run = await runRelayJob(args, {
			token: "t",
			apiUrl: "https://github.invalid",
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
			readProjectFile: async () => undefined,
			nowMs: Date.parse("2026-11-17T12:00:00Z"),
			print: (line) => lines.push(line),
			writeOutputs: async () => {},
			delimiter: DELIMITER,
		});
		expect(run.exitCode).toBe(0);
		expect(readCommands(lines).map((line) => line.title)).toEqual([
			RELAY_DECISION_NOTICE_TITLE,
			"hobo-ci-relay-facts",
		]);
	});
});

describe("the evaluator's command line", () => {
	it("fails with one annotation when its arguments are broken or it has nowhere to write", async () => {
		const lines: string[] = [];
		const base = {
			env: new Map([["GITHUB_OUTPUT", "/dev/null"]]),
			print: (line: string) => lines.push(line),
			fetch: globalThis.fetch,
			nowMs: 1,
			// Neither run gets as far as reading the checkout.
			cwd: mkdtempSync(join(tmpdir(), "hobo-relay-cli-")),
		};
		expect(await runRelayJobCli({ ...base, argv: ["--colour", "red"] })).toBe(
			1,
		);
		expect(
			await runRelayJobCli({
				...base,
				env: new Map(),
				argv: [
					"--repository",
					REPO,
					"--run-id",
					"1",
					"--job",
					"relay",
					"--event",
					"push",
				],
			}),
		).toBe(1);
		expect(readCommands(lines).map((line) => line.message)).toEqual([
			'The relay job could not answer: unknown argument "--colour".',
			"The relay job could not answer: GITHUB_OUTPUT is not set.",
		]);
	});
});
