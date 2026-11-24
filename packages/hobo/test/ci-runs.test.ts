import type { CredentialResolver } from "@hobo/cd";
import { describe, expect, it } from "vitest";
import { GITHUB_REST_ORIGIN } from "../src/ci-github-app.js";
import {
	type CiRunExec,
	type CiRunOptions,
	runCiRuns,
} from "../src/ci-runs.js";
import {
	FAKE_INSTALLATION_TOKEN,
	githubRestFetch,
	githubStatus,
	installationCredentials,
	refusingCredentials,
} from "./support/github-app-fake.js";

const sha = "a".repeat(40);
const record = {
	id: 123,
	run_attempt: 1,
	name: "CI",
	display_title: "Test the current change",
	head_branch: "feature/ci",
	head_sha: sha,
	status: "completed",
	conclusion: "failure",
	html_url: "https://github.com/owner/project/actions/runs/123",
};
const BLOB = "https://results-receiver.actions.githubusercontent.com/job-logs";
const RUN = "repos/owner/project/actions/runs/123";

const runJson = (
	fields: Readonly<Record<string, string | number | null>> = {},
) => JSON.stringify({ ...record, ...fields });
const listJson = (runs: readonly object[]) =>
	JSON.stringify({ total_count: runs.length, workflow_runs: runs });
const restJob = (
	id: number,
	name: string,
	conclusion: string | null = "success",
	status = "completed",
) => ({
	id,
	name,
	status,
	conclusion,
	started_at: "2026-11-10T10:00:00Z",
	completed_at: conclusion === null ? null : "2026-11-10T10:05:00Z",
	html_url: `https://github.com/owner/project/actions/runs/123/job/${id}`,
	steps: [],
});
const redirectTo = (location: string) =>
	new Response(null, { status: 302, headers: { location } });

type Reply = string | Response | Error;

function harness(
	replies: readonly Reply[],
	init: Readonly<{
		git?: readonly string[];
		jobs?: readonly object[];
		fallback?: () => Reply;
		access?: Readonly<{ credentials: CredentialResolver | undefined }>;
		now?: () => number;
		sleep?: (ms: number) => Promise<void>;
	}> = {},
) {
	const calls: string[] = [];
	const pending = [...replies];
	const gitOutput = [...(init.git ?? [])];
	const jobs = init.jobs ?? [];
	const execFile: CiRunExec = async (file, args) => {
		calls.push([file, ...args].join(" "));
		const stdout = gitOutput.shift();
		if (stdout === undefined) throw new Error("Unexpected external command");
		return { stdout, stderr: "" };
	};
	const rest = githubRestFetch((request) => {
		calls.push(
			request.method === "GET"
				? request.path
				: `${request.method} ${request.path}`,
		);
		if (request.path.endsWith("/jobs?per_page=100&page=1"))
			return JSON.stringify({ total_count: jobs.length, jobs });
		const next = pending.shift() ?? init.fallback?.();
		if (next === undefined)
			throw new Error(`Unexpected GitHub request ${request.path}`);
		if (next instanceof Error) throw next;
		return next;
	});
	return {
		calls,
		requests: rest.requests,
		run(
			command: string,
			args: readonly string[] = [],
			options: CiRunOptions = {},
		) {
			return runCiRuns({
				command,
				repository: "owner/project",
				cwd: process.cwd(),
				args,
				options,
				execFile,
				credentials: (init.access ?? { credentials: installationCredentials() })
					.credentials,
				fetch: rest.fetch,
				now: init.now ?? Date.now,
				sleep: init.sleep ?? (async () => {}),
			});
		},
	};
}

const posts = (calls: readonly string[]) =>
	calls.filter((call) => call.startsWith("POST "));

describe("HoBo CI GitHub Actions run boundary", () => {
	it("lists the current branch through the GitHub REST runs listing", async () => {
		const fixture = harness([listJson([record])], { git: ["feature/ci\n"] });
		const result = await fixture.run("ls");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("123  failure");
		expect(result.data).toMatchObject({
			runs: [
				{
					id: 123,
					name: "CI",
					title: "Test the current change",
					branch: "feature/ci",
					commit: sha,
					status: "completed",
					conclusion: "failure",
					url: record.html_url,
				},
			],
		});
		expect(fixture.calls).toEqual([
			"git branch --show-current",
			"repos/owner/project/actions/runs?per_page=20&branch=feature%2Fci",
		]);
	});

	it("maps Vercel status names to GitHub conclusions", async () => {
		const fixture = harness([listJson([record])]);
		expect(
			(
				await fixture.run("list", [], {
					"all-branches": true,
					status: "failed",
					limit: "100",
				})
			).ok,
		).toBe(true);
		expect(fixture.calls).toEqual([
			"repos/owner/project/actions/runs?per_page=100&status=failure",
		]);
	});

	it("rejects unsupported flags and incompatible filters before calling GitHub", async () => {
		for (const options of [
			{ follow: true },
			{ "all-branches": true, commit: sha },
			{ limit: "101" },
		]) {
			const fixture = harness([]);
			const result = await fixture.run("list", [], options);
			expect(result.code).toBe("HOBO_CLI_USAGE");
			expect(fixture.calls).toEqual([]);
		}
	});

	it("resolves inspect to the current commit without opening a picker", async () => {
		const fixture = harness([listJson([record]), runJson()], {
			git: [`${sha}\n`],
		});
		const result = await fixture.run("inspect");
		expect(result.ok).toBe(true);
		expect(fixture.calls).toEqual([
			"git rev-parse HEAD",
			`repos/owner/project/actions/runs?head_sha=${sha}&per_page=1`,
			RUN,
			`${RUN}/jobs?per_page=100&page=1`,
		]);
	});

	it("shows exact task names and status in human-readable inspection", async () => {
		const fixture = harness([runJson()], {
			jobs: [
				restJob(10, "web / test (node 24)", "failure"),
				restJob(11, "build", null, "in_progress"),
			],
		});
		const result = await fixture.run("inspect", ["123"]);
		expect(result.message).toContain("web / test (node 24)  failure");
		expect(result.message).toContain("build  in_progress");
		expect(result.data).toMatchObject({
			run: {
				jobs: [
					{
						databaseId: 10,
						name: "web / test (node 24)",
						conclusion: "failure",
					},
					{
						databaseId: 11,
						name: "build",
						status: "in_progress",
						conclusion: "",
					},
				],
			},
		});
	});

	it("sends every run read and rerun to api.github.com with the installation token", async () => {
		const fixture = harness([
			runJson(),
			runJson({ run_attempt: 1 }),
			githubStatus(201),
			runJson({ run_attempt: 2 }),
			runJson({ run_attempt: 2, status: "queued", conclusion: null }),
			runJson({ run_attempt: 2, conclusion: "success" }),
		]);
		const result = await fixture.run("rerun", ["123"], { wait: true });
		expect(result.ok).toBe(true);
		expect(fixture.requests.length).toBeGreaterThan(0);
		for (const request of fixture.requests) {
			expect(request.url.startsWith(`${GITHUB_REST_ORIGIN}/`)).toBe(true);
			expect(request.authorization).toBe(`Bearer ${FAKE_INSTALLATION_TOKEN}`);
		}
		expect(JSON.stringify(result)).not.toContain(FAKE_INSTALLATION_TOKEN);
	});

	it("only defaults rerun to a failed run and never repeats the write", async () => {
		const fixture = harness(
			[listJson([record]), runJson(), githubStatus(201)],
			{
				git: [`${sha}\n`],
			},
		);
		const result = await fixture.run("rerun");
		expect(result.status).toBe("requested");
		expect(fixture.calls[1]).toBe(
			`repos/owner/project/actions/runs?head_sha=${sha}&per_page=1&status=failure`,
		);
		expect(posts(fixture.calls)).toEqual([`POST ${RUN}/rerun`]);
	});

	it("waits for the new rerun attempt and returns failure for its failed result", async () => {
		const fixture = harness([
			runJson(),
			runJson({ run_attempt: 1 }),
			githubStatus(201),
			runJson({ run_attempt: 2 }),
			runJson({ run_attempt: 2, status: "queued", conclusion: null }),
			runJson({ run_attempt: 2 }),
		]);
		const result = await fixture.run("rerun", ["123"], { wait: true });
		expect(result.code).toBe("HOBO_CI_RUN_FAILED");
		expect(fixture.calls.slice(2, 7)).toEqual([
			RUN,
			`POST ${RUN}/rerun`,
			RUN,
			`${RUN}/attempts/2`,
			`${RUN}/attempts/2/jobs?per_page=100&page=1`,
		]);
	});

	it("reads selected failed job logs through the redirect without the installation token", async () => {
		const fixture = harness(
			[
				runJson({ run_attempt: 2 }),
				redirectTo(`${BLOB}/11.txt?sig=fixture`),
				"test step\tECONNRESET occurred\ntest step\tfinished\n",
			],
			{ jobs: [restJob(10, "build"), restJob(11, "test", "failure")] },
		);
		const result = await fixture.run("logs", ["123"], {
			failed: true,
			task: ["test"],
			grep: "econnreset",
			attempt: "2",
		});
		expect(result.message).toContain("ECONNRESET occurred");
		expect(result.message).not.toContain("finished");
		expect(fixture.calls).toEqual([
			`${RUN}/attempts/2`,
			`${RUN}/attempts/2/jobs?per_page=100&page=1`,
			"repos/owner/project/actions/jobs/11/logs",
			`${BLOB}/11.txt?sig=fixture`,
		]);
		const [, , logs, download] = fixture.requests;
		expect(logs?.redirect).toBe("manual");
		expect(download?.authorization).toBeNull();
		expect(download?.redirect).toBe("error");
	});

	it("reports partial grep results when running runs could not be searched", async () => {
		const fixture = harness(
			[
				listJson([
					record,
					{ ...record, id: 124, status: "in_progress", conclusion: null },
				]),
				"ECONNRESET\n",
			],
			{ jobs: [restJob(1, "test")] },
		);
		const result = await fixture.run("grep", ["econnreset"], {
			"all-branches": true,
		});
		expect(result.message).toContain("Search incomplete");
		expect(result.data).toMatchObject({
			searched: 1,
			partial: true,
			matches: [{ runId: 123, line: "ECONNRESET" }],
		});
		expect(fixture.calls).toContain("repos/owner/project/actions/jobs/1/logs");
	});

	it("rejects malformed GitHub JSON and keeps external error details out of output", async () => {
		const malformed = await harness(["{}"]).run("list", [], {
			"all-branches": true,
		});
		expect(malformed.code).toBe("HOBO_CI_GITHUB_FAILED");
		const result = await harness([new Error("Bearer confidential-token")]).run(
			"inspect",
			["123"],
		);
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("confidential-token");
	});

	it.each([
		["no owner store session", undefined],
		["a store that cannot mint the installation token", refusingCredentials],
	])("refuses to reach GitHub with %s", async (_case, credentials) => {
		const fixture = harness([], { access: { credentials } });
		const result = await fixture.run("list", [], { "all-branches": true });
		expect(result).toMatchObject({
			ok: false,
			status: "unauthenticated",
			code: "HOBO_CI_GITHUB_APP_NEEDED",
		});
		expect(result.remediation?.join(" ")).toContain("choose_secret_store");
		expect(result.remediation?.join(" ")).toContain("hobo ci app create");
		expect(fixture.calls).toEqual([]);
	});

	it("mints the installation token for the selected repository once per command", async () => {
		const credentials = installationCredentials();
		const fixture = harness([runJson()], { access: { credentials } });
		expect((await fixture.run("inspect", ["123"])).ok).toBe(true);
		expect(credentials.asked).toEqual(["github-app://owner/project"]);
		expect(fixture.requests).toHaveLength(2);
	});

	it("rejects run selectors that could be interpreted as flags", async () => {
		const fixture = harness([]);
		expect((await fixture.run("rerun", ["--debug"])).code).toBe(
			"HOBO_CLI_USAGE",
		);
		expect(fixture.calls).toEqual([]);
	});

	it("pins a requested attempt and tolerates its transient 404 read model", async () => {
		const fixture = harness([
			runJson(),
			runJson({ run_attempt: 1 }),
			githubStatus(201),
			runJson({ run_attempt: 2 }),
			githubStatus(404),
			runJson({ run_attempt: 2, status: "queued", conclusion: null }),
			runJson({ run_attempt: 2, conclusion: "success" }),
		]);
		const result = await fixture.run("rerun", ["123"], { wait: true });
		expect(result.ok).toBe(true);
		expect(result.data?.attempt).toBe(2);
		expect(posts(fixture.calls)).toHaveLength(1);
		const afterRerun = fixture.calls.slice(
			fixture.calls.indexOf(`POST ${RUN}/rerun`) + 2,
		);
		for (const call of afterRerun) expect(call).toContain("/attempts/2");
	});

	it.each([
		{ attempt: 2, status: "completed" },
		{ attempt: 3, status: "completed" },
		{ attempt: 3, status: "queued" },
	])("refuses ambiguous rerun attribution for $attempt / $status", async ({
		attempt,
		status,
	}) => {
		const fixture = harness([
			runJson(),
			runJson({ run_attempt: 1 }),
			githubStatus(201),
			runJson({ run_attempt: attempt }),
			runJson({
				run_attempt: attempt,
				status,
				conclusion: status === "completed" ? "success" : null,
			}),
		]);
		const result = await fixture.run("rerun", ["123"], { wait: true });
		expect(result).toMatchObject({
			ok: false,
			code: "HOBO_CI_RERUN_AMBIGUOUS",
			status: "unconfirmed",
		});
		expect(result.data).toMatchObject({
			expectedAttempt: 2,
			observedAttempt: attempt,
		});
		expect(posts(fixture.calls)).toHaveLength(1);
	});

	it("returns an explicit wait timeout while remote work continues", async () => {
		let clock = 0;
		const pending = runJson({
			run_attempt: 3,
			status: "queued",
			conclusion: null,
		});
		const fixture = harness([], {
			fallback: () => pending,
			now: () => clock,
			sleep: async () => {
				clock = 600001;
			},
		});
		const result = await fixture.run("inspect", ["123"], { wait: true });
		expect(result.code).toBe("HOBO_CI_WAIT_TIMEOUT");
		expect(result.ok).toBe(false);
	});

	it("recovers from temporary GitHub outages while waiting without repeating rerun", async () => {
		let clock = 0;
		const fixture = harness(
			[
				runJson(),
				runJson({ run_attempt: 2 }),
				githubStatus(201),
				runJson({ run_attempt: 3 }),
				runJson({ run_attempt: 3, status: "queued", conclusion: null }),
				githubStatus(503),
				runJson({ run_attempt: 3, conclusion: "success" }),
			],
			{
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			},
		);
		const result = await fixture.run("rerun", ["123"], { wait: true });
		expect(result.ok).toBe(true);
		expect(result.data?.attempt).toBe(3);
		expect(posts(fixture.calls)).toHaveLength(1);
	});

	it("bounds retries of unavailable read endpoints", async () => {
		let clock = 0;
		const fixture = harness([], {
			fallback: () => githubStatus(503),
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
		});
		const result = await fixture.run("inspect", ["123"], { wait: true });
		expect(result.code).toBe("HOBO_CI_GITHUB_FAILED");
		expect(clock).toBe(30000);
		expect(fixture.calls).toHaveLength(31);
	});

	it("returns bounded partial logs instead of failing on large output", async () => {
		const fixture = harness([runJson(), "x".repeat(3 * 1024 * 1024)], {
			jobs: [restJob(1, "test")],
		});
		const result = await fixture.run("logs", ["123"]);
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({ partial: true, truncated: true });
		expect(JSON.stringify(result.data).length).toBeLessThan(
			2 * 1024 * 1024 + 1000,
		);
	});

	it("stops reading a streamed log download at the log budget", async () => {
		let pulled = 0;
		const chunk = new TextEncoder().encode("y".repeat(64 * 1024));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				if (pulled > 64) controller.close();
				else controller.enqueue(chunk);
			},
		});
		const fixture = harness(
			[runJson(), redirectTo(`${BLOB}/1.txt`), new Response(stream)],
			{ jobs: [restJob(1, "test")] },
		);
		const result = await fixture.run("logs", ["123"]);
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({ partial: true, truncated: true });
		expect(pulled).toBeLessThan(64);
	});

	it.each([
		401, 403, 429,
	])("preserves HTTP %i from grep and task-log reads", async (status) => {
		for (const command of ["grep", "logs"]) {
			const fixture = harness(
				[
					command === "grep" ? listJson([record]) : runJson(),
					githubStatus(status),
				],
				{ jobs: [restJob(1, "test")] },
			);
			const result = await fixture.run(
				command,
				command === "grep" ? ["error"] : ["123"],
				command === "grep" ? { "all-branches": true } : {},
			);
			expect(result).toMatchObject({
				ok: false,
				code: "HOBO_CI_GITHUB_FAILED",
				data: { httpStatus: status },
			});
			expect(result.message).toContain(
				status === 429 ? "rate limited" : "denied",
			);
			expect(JSON.stringify(result)).not.toContain(FAKE_INSTALLATION_TOKEN);
		}
	});

	it("keeps available grep results when another run's logs have expired", async () => {
		const fixture = harness(
			[
				listJson([record, { ...record, id: 124 }]),
				githubStatus(404),
				"a useful ERROR line",
			],
			{ jobs: [restJob(1, "test")] },
		);
		const result = await fixture.run("grep", ["error"], {
			"all-branches": true,
		});
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({
			partial: true,
			unavailableRuns: [123],
			matches: [{ runId: 124, line: "a useful ERROR line" }],
		});
	});

	it("does not implicitly retry a run whose failed state changed after selection", async () => {
		const fixture = harness(
			[listJson([record]), runJson({ conclusion: "success" })],
			{ git: [sha] },
		);
		expect((await fixture.run("rerun")).code).toBe("HOBO_CLI_USAGE");
		expect(posts(fixture.calls)).toHaveLength(0);
	});

	it("does not require a local branch when an explicit commit is selected", async () => {
		const fixture = harness([listJson([record])]);
		expect((await fixture.run("list", [], { commit: sha })).ok).toBe(true);
		expect(fixture.calls).toEqual([
			`repos/owner/project/actions/runs?per_page=20&head_sha=${sha}`,
		]);
	});

	it("strips terminal controls from GitHub text", async () => {
		const fixture = harness([
			listJson([
				{ ...record, display_title: "\u001b]52;c;fake\u0007safe title" },
			]),
		]);
		const result = await fixture.run("list", [], { "all-branches": true });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("safe title");
		expect(result.message).not.toContain("\u001b");
	});
});
