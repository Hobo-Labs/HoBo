import { create } from "@bufbuild/protobuf";
import {
	type RelayJobMessage,
	RelayJobMessageSchema,
	type RelayJobStep,
} from "@hobo/ci";
import { describe, expect, it } from "vitest";
import type { GithubTransport } from "../src/github.js";
import {
	createRelayAnswerer,
	RELAY_CONFIG_PATH,
} from "../src/relay-answer/index.js";
import {
	checkStepsOf,
	createDockerLintSandbox,
	createRelayChecks,
	dockerLintArgs,
	GithubRelayCheckSource,
	LINT_CHECK_BUDGET_MS,
	LINT_MAX_ANNOTATIONS,
	LINT_TOOLS,
	type LintRun,
	type LintRunResult,
	type LintSandbox,
	type LintToolResult,
	lintAnnotations,
	lintFindings,
	lintToolResult,
	lintToolsOf,
	parseRelayChecksConfig,
	type RelayArchiveAccess,
	type RelayCheckCompleted,
	type RelayCheckSource,
	readCapped,
	relayCheckOf,
	runHostCommand,
	type SandboxCommand,
} from "../src/relay-checks/index.js";
import { testJitConfig } from "../src/runner-protocol/port.js";
import {
	GithubSimulator,
	SimulatedRunnerService,
	simulatorTransport,
} from "./support/github-simulator/index.js";

const REPO = "octo/app";
const TITLE_STEP = "hobo-labs/hobo/checks/pr-title@v1";
const LINT_STEP = "hobo-labs/hobo/checks/lint@v1";

function step(uses: string, inputs: Record<string, string> = {}): RelayJobStep {
	return {
		$typeName: "hobo.ci.v1.RelayJobStep",
		uses,
		inputs: Object.entries(inputs).map(([name, value]) => ({
			$typeName: "hobo.ci.v1.RelayJobValue",
			name,
			value,
		})),
	};
}

function message(
	steps: readonly RelayJobStep[],
	event = "pull_request",
): RelayJobMessage {
	return create(RelayJobMessageSchema, {
		jobId: "job-1",
		planId: "plan-1",
		repository: REPO,
		runId: 42,
		runAttempt: 1,
		job: "title",
		event,
		workflowRef: `${REPO}/.github/workflows/checks.yml@refs/pull/7/merge`,
		steps: [...steps],
	});
}

type FakeSource = RelayCheckSource & { archives: number };

function fakeSource(
	ci: string | undefined,
	title: string | undefined = "feat: add retry",
): FakeSource {
	return {
		archives: 0,
		async ciFile() {
			return ci;
		},
		async pullRequest() {
			return title === undefined ? undefined : { number: 7, title };
		},
		async commit() {
			return "a".repeat(40);
		},
		async archive() {
			this.archives += 1;
			return new Uint8Array([1, 2, 3]);
		},
	};
}

const CODELOAD =
	"https://codeload.github.com/octo/app/legacy.tar.gz/sha?token=short";

type ArchiveCall = Readonly<{
	url: string;
	redirect: RequestRedirect | undefined;
	authorization: string | null;
}>;

function codeloadArchive(
	bytes: Uint8Array,
	calls: ArchiveCall[] = [],
	location: string = CODELOAD,
): RelayArchiveAccess {
	return {
		installationToken: async (id) => `installation-${id}`,
		fetch: async (input, init) => {
			const url = String(input);
			calls.push({
				url,
				redirect: init?.redirect,
				authorization: new Headers(init?.headers).get("authorization"),
			});
			if (url.startsWith("https://api.github.com/repos/"))
				return new Response(null, { status: 302, headers: { location } });
			if (url === location)
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(bytes.slice(0, 1));
							controller.enqueue(bytes.slice(1));
							controller.close();
						},
					}),
				);
			return new Response(null, { status: 404 });
		},
	};
}

class FakeSandbox implements LintSandbox {
	readonly runs: LintRun[] = [];
	constructor(
		private readonly results: ReadonlyMap<string, LintRunResult> = new Map(),
	) {}
	async run(request: LintRun): Promise<LintRunResult> {
		this.runs.push(request);
		return (
			this.results.get(request.tool) ?? {
				exitCode: 0,
				output: "",
				timedOut: false,
			}
		);
	}
}

describe("check steps", () => {
	it("names the check a step runs, with or without a ref", () => {
		expect(relayCheckOf(TITLE_STEP)).toBe("pr-title");
		expect(relayCheckOf("./checks/lint")).toBe("lint");
		expect(relayCheckOf("actions/checkout@v4")).toBeUndefined();
	});

	it("leaves a job with no check step to be routed", () => {
		expect(checkStepsOf([])).toBeUndefined();
		expect(checkStepsOf([step("actions/checkout@v4")])).toBeUndefined();
	});

	it("refuses a job that mixes check steps with anything else", () => {
		const read = checkStepsOf([step(TITLE_STEP), step("")]);
		expect(read).toMatchObject({ ok: false });
		expect(read?.ok === false && read.problem).toContain(
			"Step 2 (a script) is not a HoBo check step",
		);
	});

	it("refuses a job that repeats a check", () => {
		const read = checkStepsOf([step(LINT_STEP), step(LINT_STEP)]);
		expect(read?.ok === false && read.problem).toContain(
			"Step 2 repeats the lint check",
		);
	});

	it("refuses an expression or an unknown input", () => {
		expect(
			checkStepsOf([step(TITLE_STEP, { types: "${{ vars.TYPES }}" })]),
		).toMatchObject({ ok: false, problem: expect.stringContaining("literal") });
		expect(checkStepsOf([step(TITLE_STEP, { scope: "api" })])).toMatchObject({
			ok: false,
			problem: 'The pr-title check takes "types", not "scope".',
		});
	});
});

describe("the checks block of .hobo/ci.json", () => {
	it("is off for lint and uses the default types when absent", () => {
		expect(parseRelayChecksConfig(undefined)).toEqual({
			ok: true,
			config: { titleTypes: [], lint: false },
		});
		expect(parseRelayChecksConfig("{}")).toMatchObject({
			ok: true,
			config: { lint: false },
		});
	});

	it("reads the allowed types and the lint switch", () => {
		expect(
			parseRelayChecksConfig(
				JSON.stringify({
					runnerOrder: {},
					checks: { prTitle: { types: ["feat", "fix"] }, lint: true },
				}),
			),
		).toEqual({
			ok: true,
			config: { titleTypes: ["feat", "fix"], lint: true },
		});
	});

	it("is strict: an unknown key or a wrong type is a sentence", () => {
		const unknown = parseRelayChecksConfig(
			JSON.stringify({ checks: { prTitel: {} } }),
		);
		expect(unknown).toMatchObject({ ok: false });
		expect(unknown.ok === false && unknown.problem).toContain("checks");
		expect(
			parseRelayChecksConfig(JSON.stringify({ checks: { lint: "yes" } })),
		).toMatchObject({
			ok: false,
			problem: expect.stringContaining("checks.lint"),
		});
		expect(parseRelayChecksConfig("{")).toEqual({
			ok: false,
			problem: ".hobo/ci.json is not valid JSON",
		});
	});
});

describe("lint results", () => {
	it("reads each tool's one-line findings", () => {
		expect(
			lintFindings(
				"shellcheck",
				"./scripts/a.sh:3:5: warning: Quote this to prevent word splitting. [SC2086]\nnoise\n",
			),
		).toEqual([
			{
				tool: "shellcheck",
				file: "scripts/a.sh",
				line: 3,
				column: 5,
				message: "warning: Quote this to prevent word splitting. [SC2086]",
			},
		]);
		expect(
			lintFindings("ruff", "app/x.py:1:8: F401 [*] `os` imported but unused"),
		).toHaveLength(1);
	});

	it("says why a tool failed when it printed no finding", () => {
		expect(
			lintToolResult(
				"oxlint",
				{ exitCode: 0, output: "", timedOut: true },
				300_000,
			),
		).toMatchObject({ passed: false, summary: "stopped after 5 minutes" });
		expect(
			lintToolResult(
				"typos",
				{ exitCode: 127, output: "", timedOut: false },
				1,
			),
		).toMatchObject({
			passed: false,
			summary: "is not installed in the sandbox image",
		});
		expect(
			lintToolResult(
				"actionlint",
				{ exitCode: 3, output: "boom\nconfig error\n", timedOut: false },
				1,
			),
		).toMatchObject({ passed: false, summary: "exited 3: config error" });
	});

	it("reads the tools a step names and refuses an unknown one", () => {
		expect(lintToolsOf(undefined)).toEqual({ ok: true, tools: LINT_TOOLS });
		expect(lintToolsOf("ruff, actionlint ruff")).toEqual({
			ok: true,
			tools: ["actionlint", "ruff"],
		});
		expect(lintToolsOf("eslint")).toMatchObject({ ok: false });
	});

	it("keeps one result per tool and at most 50 annotations", () => {
		const findings = Array.from({ length: 80 }, (_, index) => ({
			tool: "oxlint" as const,
			file: "a.ts",
			line: index + 1,
			column: 1,
			message: "no-unused-vars",
		}));
		const results: LintToolResult[] = [
			{ tool: "actionlint", passed: true, summary: "passed", findings: [] },
			{ tool: "oxlint", passed: false, summary: "80 findings", findings },
		];
		const annotations = lintAnnotations(results);
		expect(annotations).toHaveLength(LINT_MAX_ANNOTATIONS);
		expect(annotations.slice(0, 2).map((note) => note.message)).toEqual([
			"actionlint: passed",
			"oxlint: 80 findings",
		]);
		expect(annotations.at(-1)).toEqual({
			level: "warning",
			message:
				"33 more findings are not shown; run the tools locally to see them all.",
		});
	});
});

describe("createRelayChecks", () => {
	function handler(
		source: RelayCheckSource,
		sandbox: LintSandbox | undefined = undefined,
		events: RelayCheckCompleted[] = [],
	) {
		return createRelayChecks({
			source,
			sandbox,
			completed: async (event) => {
				events.push(event);
			},
			node: "node-a",
			nowMs: () => 1_700_000_000_000,
		});
	}

	it("passes a title that follows the rule and reports the check", async () => {
		const events: RelayCheckCompleted[] = [];
		const answer = await handler(
			fakeSource(undefined),
			undefined,
			events,
		)(message([step(TITLE_STEP)]));
		expect(answer).toMatchObject({
			conclusion: "succeeded",
			outputs: [
				{ name: "outcome", value: "passed" },
				{ name: "reason", value: expect.stringContaining("#7") },
			],
		});
		expect(events).toEqual([
			{
				type: "check.completed",
				repository: REPO,
				runId: 42,
				runAttempt: 1,
				jobId: "job-1",
				job: "title",
				checks: [{ name: "pr-title", passed: true }],
				conclusion: "succeeded",
				atMs: 1_700_000_000_000,
				node: "node-a",
			},
		]);
	});

	it("takes the allowed types from .hobo/ci.json, and the step's over them", async () => {
		const source = fakeSource(
			JSON.stringify({ checks: { prTitle: { types: ["feat", "fix"] } } }),
			"chore: tidy",
		);
		const fromFile = await handler(source)(message([step(TITLE_STEP)]));
		expect(fromFile?.conclusion).toBe("failed");
		expect(fromFile?.annotations[0]?.message).toBe(
			'The title of pull request #7, "chore: tidy", breaks the title rule: Unknown type "chore". Use one of: feat, fix.',
		);
		const fromStep = await handler(source)(
			message([step(TITLE_STEP, { types: "chore, fix" })]),
		);
		expect(fromStep?.conclusion).toBe("succeeded");
	});

	it("fails a title check outside a pull request", async () => {
		const answer = await handler(fakeSource(undefined))(
			message([step(TITLE_STEP)], "push"),
		);
		expect(answer?.conclusion).toBe("failed");
		expect(answer?.annotations[0]?.message).toContain(
			"this run came from push",
		);
	});

	it("fails a job that mixes in another step, and a broken checks block", async () => {
		const mixed = await handler(fakeSource(undefined))(
			message([step(TITLE_STEP), step("actions/checkout@v4")]),
		);
		expect(mixed?.conclusion).toBe("failed");
		const broken = await handler(
			fakeSource(JSON.stringify({ checks: { lint: 1 } })),
		)(message([step(TITLE_STEP)]));
		expect(broken?.annotations[0]?.message).toContain("checks.lint");
	});

	it("routes a job with no check step", async () => {
		expect(await handler(fakeSource(undefined))(message([]))).toBeUndefined();
	});

	it("keeps the lint check off unless .hobo/ci.json turns it on", async () => {
		const sandbox = new FakeSandbox();
		const source = fakeSource(undefined);
		const answer = await handler(source, sandbox)(message([step(LINT_STEP)]));
		expect(answer?.conclusion).toBe("failed");
		expect(answer?.annotations[0]?.message).toContain('"lint": true');
		expect(sandbox.runs).toHaveLength(0);
		expect(source.archives).toBe(0);
	});

	it("runs each tool once with no network and reports one result per tool", async () => {
		const sandbox = new FakeSandbox(
			new Map([
				[
					"shellcheck",
					{
						exitCode: 1,
						output: "./ci.sh:2:1: error: Couldn't parse this. [SC1073]\n",
						timedOut: false,
					},
				],
			]),
		);
		const answer = await handler(
			fakeSource(JSON.stringify({ checks: { lint: true } })),
			sandbox,
		)(message([step(LINT_STEP, { tools: "actionlint, shellcheck" })]));
		expect(sandbox.runs.map((run) => [run.tool, run.network])).toEqual([
			["actionlint", "none"],
			["shellcheck", "none"],
		]);
		expect(sandbox.runs[0]?.timeoutMs).toBe(5 * 60_000);
		expect(answer?.conclusion).toBe("failed");
		expect(answer?.annotations.map((note) => note.message)).toEqual([
			"actionlint: passed",
			"shellcheck: 1 finding",
			"shellcheck: ci.sh:2:1: error: Couldn't parse this. [SC1073]",
		]);
		expect(answer?.outputs[1]?.value).toBe(
			"Lint failed: actionlint passed; shellcheck 1 finding.",
		);
	});

	it("keeps a job with a title and a lint step to 50 annotations", async () => {
		const output = Array.from(
			{ length: 80 },
			(_, index) => `a.ts:${index + 1}:1: no-unused-vars`,
		).join("\n");
		const sandbox = new FakeSandbox(
			new Map([["oxlint", { exitCode: 1, output, timedOut: false }]]),
		);
		const answer = await handler(
			fakeSource(JSON.stringify({ checks: { lint: true } })),
			sandbox,
		)(
			message([
				step(TITLE_STEP),
				step(LINT_STEP, { tools: "actionlint, oxlint" }),
			]),
		);
		expect(answer?.annotations).toHaveLength(LINT_MAX_ANNOTATIONS);
		expect(answer?.annotations.slice(0, 3).map((note) => note.message)).toEqual(
			[
				"The title of pull request #7 follows the title rule.",
				"actionlint: passed",
				"oxlint: 80 findings",
			],
		);
		expect(answer?.annotations.at(-1)?.message).toContain(
			"34 more findings are not shown",
		);
	});

	describe("one time budget for the whole lint check", () => {
		class SlowSandbox implements LintSandbox {
			readonly runs: LintRun[] = [];
			constructor(
				private readonly hanging: ReadonlySet<string>,
				private readonly delayMs = 0,
			) {}
			run(request: LintRun): Promise<LintRunResult> {
				this.runs.push(request);
				if (this.hanging.has(request.tool)) return new Promise(() => {});
				return new Promise((resolve) =>
					setTimeout(
						() => resolve({ exitCode: 0, output: "", timedOut: false }),
						this.delayMs,
					),
				);
			}
		}

		function budgeted(
			source: RelayCheckSource,
			sandbox: LintSandbox,
			lintBudgetMs: number,
		) {
			return createRelayChecks({
				source,
				sandbox,
				completed: undefined,
				node: "node-a",
				nowMs: () => 1_700_000_000_000,
				lintBudgetMs,
			});
		}

		it("keeps the default budget well inside GitHub's job lock", () => {
			expect(LINT_CHECK_BUDGET_MS).toBe(8 * 60_000);
			expect(LINT_CHECK_BUDGET_MS).toBeLessThan(10 * 60_000);
		});

		it("answers timed out within the budget when a tool hangs", async () => {
			const sandbox = new SlowSandbox(new Set(["shellcheck"]));
			const started = performance.now();
			const answer = await budgeted(
				fakeSource(JSON.stringify({ checks: { lint: true } })),
				sandbox,
				200,
			)(
				message([step(LINT_STEP, { tools: "actionlint, shellcheck, oxlint" })]),
			);
			expect(performance.now() - started).toBeLessThan(1_000);
			expect(sandbox.runs.map((run) => run.tool)).toEqual([
				"actionlint",
				"shellcheck",
			]);
			expect(answer?.conclusion).toBe("failed");
			expect(answer?.outputs[1]?.value).toBe(
				"Lint timed out: the check's 200 ms ran out. actionlint passed; shellcheck stopped when the check's time ran out; oxlint not run: the check's time ran out.",
			);
			expect(answer?.annotations.map((note) => note.message)).toEqual([
				"actionlint: passed",
				"shellcheck: stopped when the check's time ran out",
				"oxlint: not run: the check's time ran out",
			]);
		});

		it("gives each tool only the time the check has left", async () => {
			const sandbox = new SlowSandbox(new Set(), 120);
			await budgeted(
				fakeSource(JSON.stringify({ checks: { lint: true } })),
				sandbox,
				1_000,
			)(message([step(LINT_STEP, { tools: "actionlint, shellcheck" })]));
			const [first, second] = sandbox.runs;
			expect(first?.timeoutMs).toBeLessThanOrEqual(1_000);
			expect(second?.timeoutMs).toBeLessThanOrEqual(1_000 - 100);
		});

		it("counts the archive download against the budget", async () => {
			const source = fakeSource(JSON.stringify({ checks: { lint: true } }));
			source.archive = () => new Promise(() => {});
			const sandbox = new SlowSandbox(new Set());
			const started = performance.now();
			const answer = await budgeted(
				source,
				sandbox,
				200,
			)(message([step(LINT_STEP)]));
			expect(performance.now() - started).toBeLessThan(1_000);
			expect(sandbox.runs).toHaveLength(0);
			expect(answer?.conclusion).toBe("failed");
			expect(answer?.outputs[1]?.value).toBe(
				"Lint timed out: the check's 200 ms ran out while the commit was being read. Run the job again.",
			);
		});
	});

	it("fails the lint check on a node with no sandbox", async () => {
		const answer = await handler(
			fakeSource(JSON.stringify({ checks: { lint: true } })),
		)(message([step(LINT_STEP)]));
		expect(answer?.annotations[0]?.message).toContain("no lint sandbox");
	});

	it("answers even when the event cannot be reported", async () => {
		const answer = await createRelayChecks({
			source: fakeSource(undefined),
			sandbox: undefined,
			completed: async () => {
				throw new Error("sink down");
			},
			node: "node-a",
			nowMs: () => 1,
		})(message([step(TITLE_STEP)]));
		expect(answer?.conclusion).toBe("succeeded");
	});
});

describe("GithubRelayCheckSource", () => {
	const SHA = "b".repeat(40);
	const target = create(RelayJobMessageSchema, {
		...message([step(TITLE_STEP)], "pull_request_target"),
		workflowRef: `${REPO}/.github/workflows/checks.yml@refs/heads/main`,
	});

	type RunBody = Readonly<{
		head_sha: string;
		head_branch?: string;
		head_repository?: Readonly<{ owner: Readonly<{ login: string }> }>;
		pull_requests?: readonly Readonly<{ number: number }>[];
	}>;
	type PullBody = Readonly<{
		number: number;
		title: string;
		head: Readonly<{ sha: string }>;
	}>;

	function runTransport(
		run: RunBody,
		pulls: readonly PullBody[],
		requests: string[],
	): GithubTransport {
		return {
			request: async (_installationId, path) => {
				requests.push(path);
				if (path === `/repos/${REPO}/actions/runs/42`)
					return Response.json(run);
				if (path.startsWith(`/repos/${REPO}/pulls?`))
					return Response.json(pulls);
				return Response.json({ message: "Not Found" }, { status: 404 });
			},
		};
	}

	it("finds a fork's pull request for a pull_request_target run from the run's head", async () => {
		const requests: string[] = [];
		const source = new GithubRelayCheckSource(
			runTransport(
				{
					head_sha: SHA,
					head_branch: "patch-1",
					head_repository: { owner: { login: "forker" } },
					pull_requests: [],
				},
				[
					{
						number: 5,
						title: "old: same branch",
						head: { sha: "c".repeat(40) },
					},
					{ number: 9, title: "feat: from a fork", head: { sha: SHA } },
				],
				requests,
			),
			async () => 1,
			codeloadArchive(new Uint8Array()),
		);
		expect(await source.pullRequest(target)).toEqual({
			number: 9,
			title: "feat: from a fork",
		});
		expect(requests).toEqual([
			`/repos/${REPO}/actions/runs/42`,
			`/repos/${REPO}/pulls?state=open&head=forker%3Apatch-1&per_page=100`,
		]);
	});

	it("names no pull request when none open from the run's head is at its commit", async () => {
		const source = new GithubRelayCheckSource(
			runTransport(
				{
					head_sha: SHA,
					head_branch: "patch-1",
					head_repository: { owner: { login: "forker" } },
					pull_requests: [{ number: 3 }],
				},
				[{ number: 3, title: "feat: x", head: { sha: "c".repeat(40) } }],
				[],
			),
			async () => 1,
			codeloadArchive(new Uint8Array()),
		);
		expect(await source.pullRequest(target)).toBeUndefined();
	});

	it("follows GitHub's archive redirect to codeload, without the installation token", async () => {
		const calls: ArchiveCall[] = [];
		const source = new GithubRelayCheckSource(
			runTransport({ head_sha: SHA }, [], []),
			async () => 1,
			codeloadArchive(new Uint8Array([31, 139, 8]), calls),
		);
		expect(await source.archive(target, SHA)).toEqual(
			new Uint8Array([31, 139, 8]),
		);
		expect(calls).toEqual([
			{
				url: `https://api.github.com/repos/${REPO}/tarball/${SHA}`,
				redirect: "manual",
				authorization: "Bearer installation-1",
			},
			{ url: CODELOAD, redirect: "error", authorization: null },
		]);
	});

	it("refuses an archive redirect anywhere but https codeload", async () => {
		for (const location of [
			"http://codeload.github.com/octo/app/legacy.tar.gz/sha",
			"https://evil.example/octo/app.tar.gz",
			"https://codeload.github.com:8443/octo/app.tar.gz",
		]) {
			const calls: ArchiveCall[] = [];
			const source = new GithubRelayCheckSource(
				runTransport({ head_sha: SHA }, [], []),
				async () => 1,
				codeloadArchive(new Uint8Array([1]), calls, location),
			);
			await expect(source.archive(target, SHA)).rejects.toThrow(
				"somewhere other than https://codeload.github.com",
			);
			expect(calls).toHaveLength(1);
		}
	});

	it("stops reading an archive with no content-length once it passes the cap", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(3));
			},
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			readCapped(new Response(body), 8, "the archive"),
		).rejects.toThrow("the archive is larger than");
		expect(cancelled).toBe(true);
		expect(
			await readCapped(new Response(new Uint8Array([1, 2])), 8, "the archive"),
		).toEqual(new Uint8Array([1, 2]));
	});
});

describe("the docker lint sandbox", () => {
	it("runs each tool in a fresh container with no network", async () => {
		const commands: SandboxCommand[] = [];
		const sandbox = createDockerLintSandbox({
			image: "hobo-lint@sha256:abc",
			name: () => "hobo-lint-1",
			runner: async (command) => {
				commands.push(command);
				return { exitCode: 0, output: "", timedOut: commands.length === 1 };
			},
		});
		const request: LintRun = {
			tool: "ruff",
			argv: ["ruff", "check", "."],
			archive: new Uint8Array([9]),
			timeoutMs: 1_000,
			network: "none",
		};
		await sandbox.run(request);
		const args = commands[0]?.args ?? [];
		expect(args.join(" ")).toContain("--network none");
		expect(args).toContain("--read-only");
		expect(args).toContain("--cap-drop");
		expect(args.slice(-3)).toEqual(["ruff", "check", "."]);
		expect(commands[0]?.stdin).toEqual(new Uint8Array([9]));
		expect(commands[1]?.args).toEqual(["rm", "-f", "hobo-lint-1"]);
		expect(
			dockerLintArgs("hobo-lint@sha256:abc", "hobo-lint-1", request),
		).toEqual(args);
	});

	it("pipes the archive in, reads the output and stops a run that overstays", async () => {
		const echoed = await runHostCommand({
			command: "sh",
			args: ["-c", "cat; echo done >&2; exit 3"],
			stdin: new TextEncoder().encode("archive "),
			timeoutMs: 10_000,
		});
		expect(echoed).toEqual({
			exitCode: 3,
			output: "archive done\n",
			timedOut: false,
		});
		const slow = await runHostCommand({
			command: "sh",
			args: ["-c", "sleep 5"],
			stdin: undefined,
			timeoutMs: 100,
		});
		expect(slow.timedOut).toBe(true);
		const missing = await runHostCommand({
			command: "hobo-no-such-command",
			args: [],
			stdin: undefined,
			timeoutMs: 1_000,
		});
		expect(missing.exitCode).toBe(127);
	});
});

function checksTransport(
	sim: GithubSimulator,
	title: string,
	requests: string[],
): GithubTransport {
	const inner = simulatorTransport(sim);
	return {
		request: async (installationId, path, method, body, ifNoneMatch) => {
			requests.push(path);
			if (path === `/repos/${REPO}/pulls/7`)
				return Response.json({ number: 7, title });
			return inner.request(installationId, path, method, body, ifNoneMatch);
		},
	};
}

function relayWithChecks(
	sim: GithubSimulator,
	transport: GithubTransport,
	sandbox: LintSandbox | undefined,
	events: RelayCheckCompleted[],
) {
	const answerer = createRelayAnswerer({
		relayJobs: { answer: true, label: "hobo-relay" },
		github: transport,
		runnerService: new SimulatedRunnerService(sim),
		readJitConfig: (_encoded, runnerName) => testJitConfig(runnerName),
		account: async () => "acct-1",
		node: "node-a",
		checks: createRelayChecks({
			source: new GithubRelayCheckSource(
				transport,
				async () => 1,
				codeloadArchive(new Uint8Array([31, 139])),
			),
			sandbox,
			completed: async (event) => {
				events.push(event);
			},
			node: "node-a",
			nowMs: () => sim.nowMs(),
		}),
		webhookSecret: sim.webhookSecret,
		nowMs: () => sim.nowMs(),
	});
	return { answerer };
}

describe("relay mode answers check jobs (C01, C02 at T2)", () => {
	it("fails a pull request title check with no runner and no route decision", async () => {
		const sim = new GithubSimulator();
		sim.putFile(
			REPO,
			RELAY_CONFIG_PATH,
			JSON.stringify({
				relayJobs: { answer: true },
				checks: { prTitle: { types: ["feat", "fix"] } },
			}),
		);
		const requests: string[] = [];
		const events: RelayCheckCompleted[] = [];
		const transport = checksTransport(sim, "chore: tidy", requests);
		const { answerer } = relayWithChecks(sim, transport, undefined, events);
		const queued = sim.queueJob({
			repository: REPO,
			name: "title",
			labels: ["hobo-relay"],
			event: "pull_request",
			workflowRef: `${REPO}/.github/workflows/checks.yml@refs/pull/7/merge`,
			steps: [{ uses: TITLE_STEP, with: new Map() }],
		});
		await sim.deliver(answerer.webhook);
		const done = sim.jobs().find((entry) => entry.id === queued.id);
		expect(done?.conclusion).toBe("failure");
		expect(done?.runnerName).toMatch(/^hobo-relay-/u);
		expect(done?.annotations.join("\n")).toContain("Use one of: feat, fix.");
		expect(sim.runners()).toHaveLength(0);
		expect(events.map((event) => event.checks)).toEqual([
			[{ name: "pr-title", passed: false }],
		]);
		expect(requests.some((path) => path.includes("tarball"))).toBe(false);
		expect(requests.some((path) => path.includes("logs"))).toBe(false);
	});

	it("runs the lint tools in the sandbox and passes the job", async () => {
		const sim = new GithubSimulator();
		sim.putFile(
			REPO,
			RELAY_CONFIG_PATH,
			JSON.stringify({ relayJobs: { answer: true }, checks: { lint: true } }),
		);
		const sandbox = new FakeSandbox();
		const events: RelayCheckCompleted[] = [];
		const transport = checksTransport(sim, "", []);
		const { answerer } = relayWithChecks(sim, transport, sandbox, events);
		const queued = sim.queueJob({
			repository: REPO,
			name: "lint",
			labels: ["hobo-relay"],
			steps: [{ uses: LINT_STEP, with: new Map([["tools", "typos, ruff"]]) }],
		});
		await sim.deliver(answerer.webhook);
		const done = sim.jobs().find((entry) => entry.id === queued.id);
		expect(done?.conclusion).toBe("success");
		expect(sandbox.runs.map((run) => [run.tool, run.network])).toEqual([
			["ruff", "none"],
			["typos", "none"],
		]);
		expect(done?.annotations).toEqual(["ruff: passed", "typos: passed"]);
		expect(events[0]?.conclusion).toBe("succeeded");
	});
});
