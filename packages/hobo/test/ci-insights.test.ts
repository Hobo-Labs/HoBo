import type { CredentialResolver } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import pact from "../contracts/ci-insights-github.pact.json";
import { runCiInsights } from "../src/ci-insights.js";
import {
	FAKE_INSTALLATION_TOKEN,
	githubRestFetch,
	githubStatus,
	installationCredentials,
	refusingCredentials,
} from "./support/github-app-fake.js";

const minute = 60_000;
const start = Date.parse("2026-11-10T10:00:00Z");
const iso = (ms: number): string => new Date(ms).toISOString();

type Job = Readonly<{
	id: number;
	name: string;
	labels: readonly string[];
	runner?: string;
	conclusion: string;
	waitMs: number;
	runMs: number;
	steps?: readonly Readonly<{ name: string; conclusion: string }>[];
}>;

function job(at: number, value: Job) {
	const started = at + value.waitMs;
	const steps = value.steps ?? [
		{ name: "Set up job", conclusion: "success" },
		{ name: "Run tests", conclusion: value.conclusion },
	];
	return {
		id: value.id,
		name: value.name,
		labels: value.labels,
		runner_name: value.runner ?? "",
		conclusion: value.conclusion,
		created_at: iso(at),
		started_at: iso(started),
		completed_at: iso(started + value.runMs),
		check_run_url: `https://api.github.com/repos/acme/app/check-runs/${value.id + 1000}`,
		steps: steps.map((step, index) => ({
			name: step.name,
			number: index + 1,
			conclusion: step.conclusion,
			started_at: iso(started),
			completed_at: iso(started + value.runMs),
		})),
	};
}

function run(
	id: number,
	at: number,
	extra: Readonly<{
		attempt?: number;
		conclusion?: string;
		event?: string;
		branch?: string;
		sha?: string;
		durationMs?: number;
	}> = {},
) {
	return {
		id,
		run_attempt: extra.attempt ?? 1,
		name: "ci",
		path: ".github/workflows/ci.yml",
		event: extra.event ?? "push",
		head_branch: extra.branch ?? "main",
		head_sha: extra.sha ?? `sha-${id}`,
		status: "completed",
		conclusion: extra.conclusion ?? "success",
		created_at: iso(at),
		updated_at: iso(at + (extra.durationMs ?? 60 * minute)),
		display_title: `change ${id}`,
		html_url: `https://github.com/acme/app/actions/runs/${id}`,
		actor: { login: "dev" },
	};
}

type Reply = string | Response | Error;

function github(responses: ReadonlyMap<string, Reply>) {
	const rest = githubRestFetch((request) => {
		const answer = responses.get(request.path);
		if (answer === undefined && request.path.endsWith("/logs")) return "";
		if (
			answer === undefined &&
			request.path.endsWith("/annotations?per_page=100")
		)
			return "[]";
		if (answer instanceof Error) throw answer;
		return answer;
	});
	return {
		fetch: rest.fetch,
		requests: rest.requests,
		get asked() {
			return rest.paths();
		},
	};
}

const repository = JSON.stringify({ private: true, default_branch: "main" });
const jobsPath = (id: number, attempt = 1): string =>
	`repos/acme/app/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`;

const insights = (
	command: "signals" | "diagnose",
	fake: ReturnType<typeof github>,
	args: readonly string[] = [],
	options: Readonly<Record<string, string>> = {},
	access: Readonly<{ credentials: CredentialResolver | undefined }> = {
		credentials: installationCredentials(),
	},
) =>
	runCiInsights({
		command,
		repository: "acme/app",
		args,
		options,
		credentials: access.credentials,
		fetch: fake.fetch,
		now: () => start + 24 * 60 * minute,
	});

describe("hobo ci signals", () => {
	it("reports waits, flaky jobs and runner times from recent runs", async () => {
		const flaky = run(2, start + 60 * minute, { attempt: 2 });
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				[
					"repos/acme/app/actions/runs?per_page=50",
					JSON.stringify({
						workflow_runs: [
							run(1, start),
							flaky,
							{ ...run(3, start), status: "in_progress", conclusion: null },
						],
					}),
				],
				[
					jobsPath(1),
					JSON.stringify({
						jobs: [
							job(start, {
								id: 11,
								name: "test",
								labels: ["hobo"],
								runner: "hobo-a",
								conclusion: "success",
								waitMs: 45 * minute,
								runMs: 10 * minute,
							}),
							job(start, {
								id: 12,
								name: "route",
								labels: ["ubuntu-24.04"],
								runner: "GitHub Actions 1",
								conclusion: "success",
								waitMs: 0,
								runMs: 20_000,
							}),
						],
					}),
				],
				[
					jobsPath(2, 1),
					JSON.stringify({
						jobs: [
							job(start + 60 * minute, {
								id: 21,
								name: "test",
								labels: ["hobo"],
								runner: "hobo-a",
								conclusion: "failure",
								waitMs: 10_000,
								runMs: 40 * minute,
							}),
						],
					}),
				],
				[
					jobsPath(2, 2),
					JSON.stringify({
						jobs: [
							job(start + 120 * minute, {
								id: 22,
								name: "test",
								labels: ["hobo"],
								runner: "hobo-a",
								conclusion: "success",
								waitMs: 10_000,
								runMs: 12 * minute,
							}),
						],
					}),
				],
			]),
		);
		const result = await insights("signals", fake);
		expect(result.ok).not.toBe(false);
		expect(fake.asked).not.toContain(jobsPath(3));
		const message = result.message ?? "";
		expect(message).toContain("CI signals for acme/app: 2 runs");
		expect(message).toContain("queue-waits  45 min in 1");
		expect(message).toContain("flaky-jobs  40 min in 1");
		expect(message).toContain("ci / test: 40 min in 1");
		expect(message).toContain("Below that bar: short-jobs (0.7 min).");
		expect(message).toMatch(/hobo {2}3 jobs {2}started 100%.*passed 67%/u);

		expect(result.data?.signals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "queue-waits", occurrences: 1 }),
				expect.objectContaining({ id: "flaky-jobs", occurrences: 1 }),
				expect.objectContaining({ id: "short-jobs", occurrences: 1 }),
			]),
		);
		expect(result.data?.runs).toBe(2);
	});

	it("says so when nothing reaches the bar", async () => {
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				[
					"repos/acme/app/actions/runs?per_page=5",
					JSON.stringify({ workflow_runs: [] }),
				],
			]),
		);
		const result = await insights("signals", fake, [], { runs: "5" });
		expect(result.message).toContain("0 runs");
		expect(result.message).toContain("No signal covers 30 minutes");
	});

	it.each([
		[{ runs: "0" }, []],
		[{ runs: "101" }, []],
		[{ runs: "many" }, []],
		[{}, ["extra"]],
	])("refuses %j %j as usage", async (options, args) => {
		const fake = github(new Map([["repos/acme/app", repository]]));
		const result = await insights("signals", fake, args, options);
		expect(result.code).toBe("HOBO_CLI_USAGE");
	});

	it.each([
		["no owner store session", undefined],
		["a store that cannot mint the installation token", refusingCredentials],
	])("refuses to read GitHub with %s", async (_case, credentials) => {
		const fake = github(new Map([["repos/acme/app", repository]]));
		const result = await insights("signals", fake, [], {}, { credentials });
		expect(result).toMatchObject({
			ok: false,
			status: "unauthenticated",
			code: "HOBO_CI_GITHUB_APP_NEEDED",
		});
		expect(result.remediation?.join(" ")).toContain("choose_secret_store");
		expect(result.remediation?.join(" ")).toContain("hobo ci app create");
		expect(fake.requests).toEqual([]);
	});

	it("sends the installation token only to GitHub and never prints it", async () => {
		const credentials = installationCredentials();
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				[
					"repos/acme/app/actions/runs?per_page=50",
					JSON.stringify({ workflow_runs: [] }),
				],
			]),
		);
		const result = await insights("signals", fake, [], {}, { credentials });
		expect(credentials.asked).toEqual(["github-app://acme/app"]);
		expect(fake.requests.map((request) => request.authorization)).toEqual([
			`Bearer ${FAKE_INSTALLATION_TOKEN}`,
			`Bearer ${FAKE_INSTALLATION_TOKEN}`,
		]);
		expect(JSON.stringify(result)).not.toContain(FAKE_INSTALLATION_TOKEN);
		const denied = await insights(
			"signals",
			github(new Map([["repos/acme/app", githubStatus(401)]])),
		);
		expect(JSON.stringify(denied)).not.toContain(FAKE_INSTALLATION_TOKEN);
	});

	it("explains a denial, a timeout and a response that is not a run list", async () => {
		const denied = await insights(
			"signals",
			github(new Map([["repos/acme/app", githubStatus(403)]])),
		);
		expect(denied).toMatchObject({
			ok: false,
			code: "HOBO_CI_GITHUB_FAILED",
		});
		expect(denied.message).toContain("GitHub denied this read");
		const timedOut = await insights(
			"signals",
			github(
				new Map([
					[
						"repos/acme/app",
						new DOMException("The operation timed out.", "TimeoutError"),
					],
				]),
			),
		);
		expect(timedOut.code).toBe("HOBO_CI_OPERATION_TIMEOUT");
		const garbled = await insights(
			"signals",
			github(
				new Map([
					["repos/acme/app", repository],
					["repos/acme/app/actions/runs?per_page=50", '{"runs":[]}'],
				]),
			),
		);
		expect(garbled.code).toBe("HOBO_CI_GITHUB_FAILED");
	});
});

describe("hobo ci diagnose", () => {
	const failedRun = run(7, start, { conclusion: "failure" });
	const log = [
		"2026-11-10T10:05:00.0000000Z > app@1.0.0 check",
		"2026-11-10T10:05:01.0000000Z src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
		"2026-11-10T10:05:02.0000000Z ##[error]Process completed with exit code 2.",
	].join("\n");

	it("diagnoses the latest failed run: the step, the kind and the re-run outlook", async () => {
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				[
					"repos/acme/app/actions/runs?status=failure&per_page=1",
					JSON.stringify({ workflow_runs: [failedRun] }),
				],
				[
					jobsPath(7),
					JSON.stringify({
						jobs: [
							job(start, {
								id: 71,
								name: "check",
								labels: ["ubuntu-24.04"],
								runner: "GitHub Actions 3",
								conclusion: "failure",
								waitMs: 5000,
								runMs: 5 * minute,
								steps: [
									{ name: "Set up job", conclusion: "success" },
									{ name: "Run pnpm check", conclusion: "failure" },
								],
							}),
							job(start, {
								id: 72,
								name: "lint",
								labels: ["ubuntu-24.04"],
								runner: "GitHub Actions 4",
								conclusion: "success",
								waitMs: 5000,
								runMs: minute,
							}),
						],
					}),
				],
				["repos/acme/app/actions/jobs/71/logs", log],
				[
					"repos/acme/app/check-runs/1071/annotations?per_page=100",
					JSON.stringify([{ message: "Process completed with exit code 2." }]),
				],
			]),
		);
		const result = await insights("diagnose", fake);
		const message = result.message ?? "";
		expect(message).toContain("ci #7: change 7");
		expect(message).toContain("check  (GitHub Actions 3)");
		expect(message).toContain(
			'Failed at "Run pnpm check": looks like a build error; a re-run will likely fail the same way.',
		);
		expect(message).toContain("error TS2322");
		expect(message).not.toContain("2026-11-10T10:05:01");
		expect(fake.asked).not.toContain("repos/acme/app/actions/jobs/72/logs");
		expect(result.data).toMatchObject({
			run: { id: 7, attempt: 1 },
			more: 0,
			jobs: [
				{
					job: "check",
					id: 71,
					diagnosis: { kind: "build", rerun: "likely-fails" },
				},
			],
		});
	});

	it("sanitizes GitHub metadata and log text in terminal output", async () => {
		const maliciousRun = {
			...failedRun,
			name: "ci\u001b]0;owned\u0007",
			display_title: "change\u202e\r\u0008",
		};
		const maliciousJob = job(start, {
			id: 71,
			name: "check\u001b[2J\u202e",
			labels: ["hobo"],
			runner: "runner\r\u0008",
			conclusion: "failure",
			waitMs: 0,
			runMs: minute,
			steps: [
				{ name: "Set up job", conclusion: "success" },
				{ name: "Run\u001b[31m tests\u001b[0m\u202e", conclusion: "failure" },
			],
		});
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(maliciousRun)],
				[jobsPath(7), JSON.stringify({ jobs: [maliciousJob] })],
				[
					"repos/acme/app/actions/jobs/71/logs",
					"\u001b]0;owned\u0007error TS2322\u0007\u202e",
				],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(result.message).toContain("ci #7");
		expect(result.message).toContain("error TS2322");
		expect(result.message).not.toContain("\u001b");
		expect(result.message).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u);
		expect(result.message?.replaceAll("\n", "")).not.toMatch(/\p{Cc}/u);
	});

	it("reads annotations after the first page", async () => {
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(failedRun)],
				[
					jobsPath(7),
					JSON.stringify({
						jobs: [
							job(start, {
								id: 71,
								name: "check",
								labels: ["hobo"],
								conclusion: "failure",
								waitMs: 0,
								runMs: minute,
							}),
						],
					}),
				],
				[
					"repos/acme/app/check-runs/1071/annotations?per_page=100",
					JSON.stringify(
						Array.from({ length: 100 }, () => ({ message: null })),
					),
				],
				[
					"repos/acme/app/check-runs/1071/annotations?per_page=100&page=2",
					JSON.stringify([
						{ message: "src/index.ts(3,7): error TS2322: type mismatch" },
					]),
				],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(fake.asked).toContain(
			"repos/acme/app/check-runs/1071/annotations?per_page=100&page=2",
		);
		expect(result.data?.jobs?.[0]?.diagnosis).toMatchObject({
			kind: "build",
			evidence: ["src/index.ts(3,7): error TS2322: type mismatch"],
		});
	});

	it("surfaces a truncated job log in the diagnosis", async () => {
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(failedRun)],
				[
					jobsPath(7),
					JSON.stringify({
						jobs: [
							job(start, {
								id: 71,
								name: "test",
								labels: ["hobo"],
								conclusion: "failure",
								waitMs: 0,
								runMs: minute,
							}),
						],
					}),
				],
				[
					"repos/acme/app/actions/jobs/71/logs",
					"x".repeat(16 * 1024 * 1024 + 1),
				],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(result.message).toContain(
			"Log output was truncated; diagnosis may be incomplete.",
		);
		expect(result.data?.jobs?.[0]?.logTruncated).toBe(true);
	});

	it("calls a job that never reached a step a runner problem worth re-running", async () => {
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(failedRun)],
				[
					jobsPath(7),
					JSON.stringify({
						jobs: [
							job(start, {
								id: 71,
								name: "test",
								labels: ["hobo"],
								runner: "hobo-a",
								conclusion: "failure",
								waitMs: 0,
								runMs: 3000,
								steps: [{ name: "Set up job", conclusion: "failure" }],
							}),
						],
					}),
				],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(result.message).toContain("a re-run will likely pass");
		expect(result.data).toMatchObject({
			jobs: [
				{
					diagnosis: {
						kind: "infra",
						rerun: "likely-passes",
						runnerFailed: true,
					},
				},
			],
		});
	});

	it("reads at most five failed jobs and says how many it left", async () => {
		const jobs = Array.from({ length: 7 }, (_, index) =>
			job(start, {
				id: 100 + index,
				name: `shard ${index}`,
				labels: ["hobo"],
				runner: "hobo-a",
				conclusion: "failure",
				waitMs: 0,
				runMs: minute,
			}),
		);
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(failedRun)],
				[jobsPath(7), JSON.stringify({ jobs })],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(result.message).toContain("2 more failed job(s) not read.");
		expect(result.data?.more).toBe(2);
		expect(fake.asked.filter((path) => path.endsWith("/logs"))).toHaveLength(5);
	});

	it("finds failed jobs after the first GitHub jobs page", async () => {
		const successful = Array.from({ length: 100 }, (_, index) =>
			job(start, {
				id: index + 1,
				name: `shard ${index}`,
				labels: ["hobo"],
				runner: "hobo-a",
				conclusion: "success",
				waitMs: 0,
				runMs: minute,
			}),
		);
		const failed = job(start, {
			id: 101,
			name: "last shard",
			labels: ["hobo"],
			runner: "hobo-a",
			conclusion: "failure",
			waitMs: 0,
			runMs: minute,
		});
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(failedRun)],
				[jobsPath(7), JSON.stringify({ jobs: successful })],
				[`${jobsPath(7)}&page=2`, JSON.stringify({ jobs: [failed] })],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(fake.asked).toContain(`${jobsPath(7)}&page=2`);
		expect(result.data?.jobs).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: 101 })]),
		);
		expect(result.message).not.toContain("No job of this run failed");
	});

	it("does not report a partial jobs list as complete when another page fails", async () => {
		const jobs = Array.from({ length: 100 }, (_, index) =>
			job(start, {
				id: index + 1,
				name: `shard ${index}`,
				labels: ["hobo"],
				conclusion: "success",
				waitMs: 0,
				runMs: minute,
			}),
		);
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(failedRun)],
				[jobsPath(7), JSON.stringify({ jobs })],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(result.ok).toBe(false);
		expect(result.message).not.toContain("No job of this run failed");
	});

	it("reports the job limit instead of silently truncating an oversized attempt", async () => {
		const fake = github(
			new Map([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(failedRun)],
				[jobsPath(7), JSON.stringify({ total_count: 1001, jobs: [] })],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(result).toMatchObject({ ok: false, code: "HOBO_CI_JOB_LIMIT" });
		expect(result.message).toContain("1000");
	});

	it.each([
		"logs",
		"annotations",
	] as const)("fails diagnosis when the %s read fails", async (resource) => {
		const path =
			resource === "logs"
				? "repos/acme/app/actions/jobs/71/logs"
				: "repos/acme/app/check-runs/1071/annotations?per_page=100";
		const fake = github(
			new Map<string, Reply>([
				["repos/acme/app", repository],
				["repos/acme/app/actions/runs/7", JSON.stringify(failedRun)],
				[
					jobsPath(7),
					JSON.stringify({
						jobs: [
							job(start, {
								id: 71,
								name: "test",
								labels: ["hobo"],
								conclusion: "failure",
								waitMs: 0,
								runMs: minute,
							}),
						],
					}),
				],
				[path, githubStatus(500)],
			]),
		);
		const result = await insights("diagnose", fake, ["7"]);
		expect(result).toMatchObject({ ok: false, code: "HOBO_CI_GITHUB_FAILED" });
	});

	it("validates the repository before constructing GitHub REST paths", async () => {
		const fake = github(new Map());
		const result = await runCiInsights({
			command: "signals",
			repository: "acme/app?unexpected=path",
			args: [],
			options: {},
			credentials: installationCredentials(),
			fetch: fake.fetch,
		});
		expect(result).toMatchObject({ ok: false, code: "HOBO_CLI_USAGE" });
		expect(fake.asked).toEqual([]);
	});

	it("says so when there is nothing to diagnose", async () => {
		const none = await insights(
			"diagnose",
			github(
				new Map([
					["repos/acme/app", repository],
					[
						"repos/acme/app/actions/runs?status=failure&per_page=1",
						JSON.stringify({ workflow_runs: [] }),
					],
				]),
			),
		);
		expect(none.message).toBe("No failed run in acme/app's recent history.");
		const green = await insights(
			"diagnose",
			github(
				new Map([
					["repos/acme/app", repository],
					["repos/acme/app/actions/runs/7", JSON.stringify(run(7, start))],
					[jobsPath(7), JSON.stringify({ jobs: [] })],
				]),
			),
			["7"],
		);
		expect(green.message).toContain("No job of this run failed or timed out.");
	});

	it.each([
		[["7", "8"]],
		[["latest"]],
		[["0"]],
	])("refuses %j as usage", async (args) => {
		const fake = github(new Map([["repos/acme/app", repository]]));
		expect((await insights("diagnose", fake, args)).code).toBe(
			"HOBO_CLI_USAGE",
		);
	});

	it("reports a run GitHub does not have", async () => {
		const result = await insights(
			"diagnose",
			github(new Map([["repos/acme/app", repository]])),
			["999"],
		);
		expect(result.code).toBe("HOBO_CI_GITHUB_FAILED");
		expect(result.message).toContain("no such repository or run");
	});
});

describe("GitHub read contract", () => {
	const fakeFor = (interactions: typeof pact.interactions) =>
		github(
			new Map(
				interactions.map((interaction) => [
					interaction.request.path,
					interaction.response.status === 302
						? new Response(null, {
								status: 302,
								headers: {
									location: interaction.response.headers?.Location ?? "",
								},
							})
						: interaction.response.headers
							? String(interaction.response.body)
							: JSON.stringify(interaction.response.body),
				]),
			),
		);
	const expectReads = (
		fake: ReturnType<typeof github>,
		interactions: typeof pact.interactions,
	) =>
		expect(fake.asked).toEqual(
			interactions.map((interaction) => interaction.request.path),
		);

	it("reads recent runs for signals from exactly the contract", async () => {
		const paths = new Set([
			"repos/acme/app",
			"repos/acme/app/actions/runs?per_page=50",
			"repos/acme/app/actions/runs/7/attempts/1/jobs?per_page=100",
		]);
		const interactions = pact.interactions.filter((interaction) =>
			paths.has(interaction.request.path),
		);
		const fake = fakeFor(interactions);
		const result = await insights("signals", fake);
		expectReads(fake, interactions);
		expect(result.data).toMatchObject({ repository: "acme/app", runs: 1 });
	});

	it("diagnoses a run from exactly the reads the contract names", async () => {
		const interactions = pact.interactions.filter(
			(interaction) =>
				interaction.request.path !== "repos/acme/app/actions/runs?per_page=50",
		);
		const fake = fakeFor(interactions);
		const result = await insights("diagnose", fake);
		expectReads(fake, interactions);
		const download = fake.requests.find((request) =>
			request.url.startsWith("https://results-receiver."),
		);
		expect(download?.authorization).toBeNull();
		expect(
			fake.requests.find((request) => request.path.endsWith("/71/logs"))
				?.redirect,
		).toBe("manual");
		expect(result.data).toMatchObject({
			run: { id: 7, attempt: 1 },
			jobs: [
				{
					job: "check",
					runner: "GitHub Actions 3",
					diagnosis: {
						failedStep: { name: "Run pnpm check", number: 2 },
						kind: "build",
						rerun: "likely-fails",
					},
				},
			],
		});
	});
});
