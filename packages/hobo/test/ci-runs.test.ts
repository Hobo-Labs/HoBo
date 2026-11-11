import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CiProcessError,
	type CiRunExec,
	type CiRunOptions,
	runCiRuns,
} from "../src/ci-runs.js";

const sha = "a".repeat(40);
const record = {
	databaseId: 123,
	name: "CI",
	displayTitle: "Test the current change",
	headBranch: "feature/ci",
	headSha: sha,
	status: "completed",
	conclusion: "failure",
	url: "https://github.com/owner/project/actions/runs/123",
};
const fields =
	"databaseId,name,displayTitle,headBranch,headSha,status,conclusion,url";

function harness(outputs: readonly (string | Error)[]) {
	const calls: { file: string; args: readonly string[]; timeout: number }[] =
		[];
	const pending = [...outputs];
	const execute: CiRunExec = async (file, args, options) => {
		calls.push({ file, args, timeout: options.timeout });
		const stdout = pending.shift();
		if (stdout === undefined) throw new Error("Unexpected external command");
		if (stdout instanceof Error) throw stdout;
		return { stdout, stderr: "" };
	};
	return {
		calls,
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
				execFile: execute,
				// The waits are between scripted replies: nothing changes while
				// they pass, so a real 1–3 s sleep only adds time.
				sleep: async () => {},
			});
		},
	};
}

describe("HoBo CI GitHub Actions run boundary", () => {
	it("lists the current branch with explicit repository and bounded JSON fields", async () => {
		const fixture = harness(["feature/ci\n", JSON.stringify([record])]);
		const result = await fixture.run("ls");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("123  failure");
		expect(fixture.calls).toEqual([
			{ file: "git", args: ["branch", "--show-current"], timeout: 30000 },
			{
				file: "gh",
				args: [
					"run",
					"list",
					"--json",
					fields,
					"--limit",
					"20",
					"--branch",
					"feature/ci",
					"--repo",
					"github.com/owner/project",
				],
				timeout: 30000,
			},
		]);
	});

	it("maps Vercel status names to GitHub conclusions", async () => {
		const fixture = harness([JSON.stringify([record])]);
		expect(
			(
				await fixture.run("list", [], {
					"all-branches": true,
					status: "failed",
					limit: "100",
				})
			).ok,
		).toBe(true);
		expect(fixture.calls[0]?.args).toEqual([
			"run",
			"list",
			"--json",
			fields,
			"--limit",
			"100",
			"--status",
			"failure",
			"--repo",
			"github.com/owner/project",
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
		const fixture = harness([
			`${sha}\n`,
			JSON.stringify([record]),
			JSON.stringify({ ...record, jobs: [] }),
		]);
		const result = await fixture.run("inspect");
		expect(result.ok).toBe(true);
		expect(fixture.calls[1]?.args).toContain(sha);
		expect(fixture.calls[2]?.args).toEqual([
			"run",
			"view",
			"123",
			"--json",
			`${fields},jobs`,
			"--repo",
			"github.com/owner/project",
		]);
	});

	it("shows exact task names and status in human-readable inspection", async () => {
		const fixture = harness([
			JSON.stringify({
				...record,
				jobs: [
					{
						databaseId: 10,
						name: "web / test (node 24)",
						status: "completed",
						conclusion: "failure",
					},
					{
						databaseId: 11,
						name: "build",
						status: "in_progress",
						conclusion: "",
					},
				],
			}),
		]);
		const result = await fixture.run("inspect", ["123"]);
		expect(result.message).toContain("web / test (node 24)  failure");
		expect(result.message).toContain("build  in_progress");
	});

	it("pins public GitHub for run reads and retry polling even with enterprise defaults", async () => {
		const fixture = harness([
			JSON.stringify({ ...record, jobs: [] }),
			"1\n",
			"",
			"2\n",
			JSON.stringify({ ...record, status: "queued", conclusion: "", jobs: [] }),
			JSON.stringify({ ...record, conclusion: "success", jobs: [] }),
		]);
		const result = await fixture.run("rerun", ["123"], { wait: true });
		expect(result.ok).toBe(true);
		for (const call of fixture.calls) {
			if (call.args[0] === "api") {
				expect(call.args).toContain("--hostname");
				expect(call.args).toContain("github.com");
			} else {
				expect(call.args).toContain("--repo");
				expect(call.args).toContain("github.com/owner/project");
			}
		}
	});

	it("only defaults rerun to a failed run and never repeats the write", async () => {
		const fixture = harness([
			`${sha}\n`,
			JSON.stringify([record]),
			JSON.stringify({ ...record, jobs: [] }),
			"",
		]);
		const result = await fixture.run("rerun");
		expect(result.status).toBe("requested");
		expect(fixture.calls[1]?.args).toEqual([
			"run",
			"list",
			"--commit",
			sha,
			"--limit",
			"1",
			"--json",
			fields,
			"--status",
			"failure",
			"--repo",
			"github.com/owner/project",
		]);
		expect(
			fixture.calls.filter((call) => call.args.includes("rerun")),
		).toHaveLength(1);
	});

	it("waits for the new rerun attempt and returns failure for its failed result", async () => {
		const fixture = harness([
			JSON.stringify({ ...record, jobs: [] }),
			"1\n",
			"",
			"2\n",
			JSON.stringify({ ...record, status: "queued", conclusion: "", jobs: [] }),
			JSON.stringify({ ...record, jobs: [] }),
		]);
		const result = await fixture.run("rerun", ["123"], { wait: true });
		expect(result.code).toBe("HOBO_CI_RUN_FAILED");
		expect(fixture.calls[1]?.args).toEqual([
			"api",
			"repos/owner/project/actions/runs/123",
			"--jq",
			".run_attempt",
			"--hostname",
			"github.com",
		]);
		expect(fixture.calls[4]).toEqual({
			file: "gh",
			args: [
				"run",
				"view",
				"123",
				"--attempt",
				"2",
				"--json",
				`${fields},jobs`,
				"--repo",
				"github.com/owner/project",
			],
			timeout: 30000,
		});
	});

	it("reads selected failed job logs and filters text case insensitively", async () => {
		const jobs = [
			{ databaseId: 10, name: "build", conclusion: "success" },
			{ databaseId: 11, name: "test", conclusion: "failure" },
		];
		const fixture = harness([
			JSON.stringify({ ...record, jobs }),
			"test step\tECONNRESET occurred\ntest step\tfinished\n",
		]);
		const result = await fixture.run("logs", ["123"], {
			failed: true,
			task: ["test"],
			grep: "econnreset",
			attempt: "2",
		});
		expect(result.message).toContain("ECONNRESET occurred");
		expect(result.message).not.toContain("finished");
		expect(fixture.calls[1]?.args).toEqual([
			"run",
			"view",
			"123",
			"--attempt",
			"2",
			"--job",
			"11",
			"--log",
			"--repo",
			"github.com/owner/project",
		]);
	});

	it("reports partial grep results when running runs could not be searched", async () => {
		const fixture = harness([
			JSON.stringify([
				record,
				{ ...record, databaseId: 124, status: "in_progress", conclusion: "" },
			]),
			"ECONNRESET\n",
		]);
		const result = await fixture.run("grep", ["econnreset"], {
			"all-branches": true,
		});
		expect(result.message).toContain("Search incomplete");
		expect(result.data).toMatchObject({
			searched: 1,
			partial: true,
			matches: [{ runId: 123, line: "ECONNRESET" }],
		});
	});

	it("rejects malformed GitHub JSON and keeps external error details out of output", async () => {
		const malformed = harness(["{}"]).run("list", [], { "all-branches": true });
		expect((await malformed).code).toBe("HOBO_CI_GITHUB_FAILED");
		const result = await runCiRuns({
			command: "inspect",
			repository: "owner/project",
			cwd: process.cwd(),
			args: ["123"],
			options: {},
			execFile: async () => {
				throw new Error("Bearer confidential-token");
			},
		});
		expect(result.ok).toBe(false);
		expect(JSON.stringify(result)).not.toContain("confidential-token");
	});

	it("rejects run selectors that could be interpreted as flags", async () => {
		const fixture = harness([]);
		expect((await fixture.run("rerun", ["--debug"])).code).toBe(
			"HOBO_CLI_USAGE",
		);
		expect(fixture.calls).toEqual([]);
	});
	it("pins a requested attempt and tolerates its transient 404 read model", async () => {
		const calls: string[][] = [];
		const outputs = [
			JSON.stringify({ ...record, jobs: null }),
			"1",
			"",
			"2",
			new CiProcessError("failed", "gh", 404),
			JSON.stringify({ ...record, status: "queued", conclusion: "", jobs: [] }),
			JSON.stringify({ ...record, conclusion: "success", jobs: [] }),
		];
		const result = await runCiRuns({
			command: "rerun",
			repository: "owner/project",
			cwd: process.cwd(),
			args: ["123"],
			options: { wait: true },
			sleep: async () => {},
			execFile: async (_file, args) => {
				calls.push([...args]);
				const stdout = outputs.shift();
				if (stdout instanceof Error) throw stdout;
				if (stdout === undefined) throw new Error("Unexpected call");
				return { stdout, stderr: "" };
			},
		});
		expect(result.ok).toBe(true);
		expect(result.data?.attempt).toBe(2);
		expect(calls.filter((args) => args.includes("rerun"))).toHaveLength(1);
		for (const args of calls.slice(4)) expect(args).toContain("--attempt");
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
			JSON.stringify({ ...record, jobs: [] }),
			"1",
			"",
			String(attempt),
			JSON.stringify({
				...record,
				status,
				conclusion: status === "completed" ? "success" : "",
				jobs: [],
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
		expect(
			fixture.calls.filter((call) => call.args.includes("rerun")),
		).toHaveLength(1);
	});
	it("returns an explicit wait timeout while remote work continues", async () => {
		let clock = 0;
		const pending = JSON.stringify({
			...record,
			status: "queued",
			conclusion: "",
			jobs: [],
		});
		const outputs = [pending, "3", pending];
		const result = await runCiRuns({
			command: "inspect",
			repository: "owner/project",
			cwd: process.cwd(),
			args: ["123"],
			options: { wait: true },
			now: () => clock,
			sleep: async () => {
				clock = 600001;
			},
			execFile: async () => ({
				stdout: outputs.shift() ?? pending,
				stderr: "",
			}),
		});
		expect(result.code).toBe("HOBO_CI_WAIT_TIMEOUT");
		expect(result.ok).toBe(false);
	});
	it("recovers from temporary GitHub outages while waiting without repeating rerun", async () => {
		let clock = 0;
		const calls: string[][] = [];
		const outputs = [
			JSON.stringify({ ...record, jobs: [] }),
			"2",
			"",
			"3",
			JSON.stringify({ ...record, status: "queued", conclusion: "", jobs: [] }),
			new CiProcessError("failed", "gh", 503),
			JSON.stringify({ ...record, conclusion: "success", jobs: [] }),
		];
		const result = await runCiRuns({
			command: "rerun",
			repository: "owner/project",
			cwd: process.cwd(),
			args: ["123"],
			options: { wait: true },
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
			execFile: async (_file, args) => {
				calls.push([...args]);
				const stdout = outputs.shift();
				if (stdout instanceof Error) throw stdout;
				if (stdout === undefined) throw new Error("Unexpected call");
				return { stdout, stderr: "" };
			},
		});
		expect(result.ok).toBe(true);
		expect(result.data?.attempt).toBe(3);
		expect(calls.filter((args) => args.includes("rerun"))).toHaveLength(1);
	});
	it("bounds retries of unavailable read endpoints", async () => {
		let clock = 0;
		let calls = 0;
		const result = await runCiRuns({
			command: "inspect",
			repository: "owner/project",
			cwd: process.cwd(),
			args: ["123"],
			options: { wait: true },
			now: () => clock,
			sleep: async (ms) => {
				clock += ms;
			},
			execFile: async () => {
				calls++;
				throw new CiProcessError("failed", "gh", 503);
			},
		});
		expect(result.code).toBe("HOBO_CI_GITHUB_FAILED");
		expect(clock).toBe(30000);
		expect(calls).toBe(31);
	});
	it("returns bounded partial logs instead of failing on large output", async () => {
		const fixture = harness([
			JSON.stringify({
				...record,
				jobs: [{ databaseId: 1, name: "test", conclusion: "success" }],
			}),
			"x".repeat(3 * 1024 * 1024),
		]);
		const result = await fixture.run("logs", ["123"]);
		expect(result.ok).toBe(true);
		expect(result.data).toMatchObject({ partial: true, truncated: true });
		expect(JSON.stringify(result.data).length).toBeLessThan(
			2 * 1024 * 1024 + 1000,
		);
	});
	it.skipIf(process.platform === "win32")(
		"bounds stdout from the real child-process executor",
		async () => {
			const directory = await mkdtemp(join(tmpdir(), "hobo-ci-gh-overflow-"));
			try {
				const metadata = JSON.stringify({
					...record,
					jobs: [{ databaseId: 1, name: "test", conclusion: "success" }],
				});
				await writeFile(
					join(directory, "gh"),
					`#!${process.execPath}\nrequire('node:fs').writeFileSync(1, process.argv.includes('--log') ? 'x'.repeat(3 * 1024 * 1024) : ${JSON.stringify(metadata)});\n`,
					{ mode: 0o700 },
				);
				const result = await runCiRuns({
					command: "logs",
					repository: "owner/project",
					cwd: directory,
					args: ["123"],
					options: {},
					env: {
						...process.env,
						PATH: `${directory}${delimiter}${process.env.PATH ?? ""}`,
					},
				});
				expect(result.ok).toBe(true);
				expect(result.data).toMatchObject({ partial: true, truncated: true });
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
	it.each([
		401, 403, 429,
	])("preserves HTTP %i from grep and task-log reads", async (status) => {
		for (const command of ["grep", "logs"]) {
			const fixture = harness([
				JSON.stringify(
					command === "grep"
						? [record]
						: { ...record, jobs: [{ databaseId: 1, name: "test" }] },
				),
				new CiProcessError("failed", "gh", status),
			]);
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
		}
	});
	it("keeps available grep results when another run's logs have expired", async () => {
		const fixture = harness([
			JSON.stringify([record, { ...record, databaseId: 124 }]),
			new CiProcessError("failed", "gh", 404),
			"a useful ERROR line",
		]);
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
		const fixture = harness([
			sha,
			JSON.stringify([record]),
			JSON.stringify({ ...record, conclusion: "success", jobs: [] }),
		]);
		expect((await fixture.run("rerun")).code).toBe("HOBO_CLI_USAGE");
		expect(
			fixture.calls.filter((call) => call.args.includes("rerun")),
		).toHaveLength(0);
	});
	it("does not require a local branch when an explicit commit is selected", async () => {
		const fixture = harness([JSON.stringify([record])]);
		expect((await fixture.run("list", [], { commit: sha })).ok).toBe(true);
		expect(fixture.calls[0]?.file).toBe("gh");
		expect(fixture.calls[0]?.args).not.toContain("--branch");
	});
	it("removes CI account credentials from child processes and strips terminal controls", async () => {
		const result = await runCiRuns({
			command: "list",
			repository: "owner/project",
			cwd: process.cwd(),
			args: [],
			options: { "all-branches": true },
			env: {
				GH_TOKEN: "github-token",
				HOBO_CI_ACCOUNT_TOKEN: "relay-token",
				HOBO_CI_ACCOUNT_TOKEN_FILE: "/mounted/token",
			},
			execFile: async (_file, _args, options) => {
				expect(options.env?.GH_TOKEN).toBe("github-token");
				expect(options.env?.HOBO_CI_ACCOUNT_TOKEN).toBeUndefined();
				expect(options.env?.HOBO_CI_ACCOUNT_TOKEN_FILE).toBeUndefined();
				return {
					stdout: JSON.stringify([
						{ ...record, displayTitle: "\u001b]52;c;fake\u0007safe title" },
					]),
					stderr: "",
				};
			},
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("safe title");
		expect(result.message).not.toContain("\u001b");
	});
});
