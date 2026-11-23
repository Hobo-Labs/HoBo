import { createHoboCli } from "@hobo/cli";
import { describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import type { CiCommandContext } from "../src/ci-commands.js";
import {
	CI_RERUN_REROUTE_COMMAND,
	wantsReroute,
} from "../src/ci-rerun-reroute.js";

const REPO = "octo/app";
const TOKEN = "test-token-not-real";

type FakeJob = { id: number; name: string; labels: string[] };

function fakeGithub(
	init: Readonly<{
		status?: string;
		jobs?: FakeJob[];
		rerunStatus?: number;
		origin?: string;
	}> = {},
) {
	const origin = init.origin ?? "https://api.github.com";
	const requests: { method: string; path: string; auth: string }[] = [];
	const jobs = init.jobs ?? [
		{ id: 11, name: "route", labels: ["hobo-relay"] },
		{ id: 12, name: "build", labels: ["ubuntu-24.04"] },
	];
	const fetchImpl: typeof fetch = async (input, requestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const method = requestInit?.method ?? "GET";
		const auth = new Headers(requestInit?.headers).get("authorization") ?? "";
		requests.push({ method, path: `${url.origin}${url.pathname}`, auth });
		const base = `/repos/${REPO}/actions`;
		if (url.origin !== origin) throw new TypeError("fetch failed");
		if (method === "GET" && url.pathname === `${base}/runs/77`)
			return Response.json({
				status: init.status ?? "completed",
				conclusion: "failure",
				run_attempt: 1,
			});
		if (
			method === "GET" &&
			url.pathname === `${base}/runs/77/attempts/1/jobs`
		) {
			const perPage = Number(url.searchParams.get("per_page") ?? "30");
			const page = Number(url.searchParams.get("page") ?? "1");
			return Response.json({
				total_count: jobs.length,
				jobs: jobs
					.slice((page - 1) * perPage, page * perPage)
					.map((job) => ({ ...job, conclusion: "failure" })),
			});
		}
		const rerun = new RegExp(`^${base}/jobs/(\\d+)/rerun$`, "u").exec(
			url.pathname,
		);
		if (method === "POST" && rerun)
			return (init.rerunStatus ?? 201) === 201
				? Response.json({}, { status: 201 })
				: Response.json(
						{ message: "Resource not accessible by integration" },
						{ status: init.rerunStatus },
					);
		return Response.json({ message: "Not Found" }, { status: 404 });
	};
	return { fetch: fetchImpl, requests };
}

function context(
	args: readonly string[],
	github: ReturnType<typeof fakeGithub>,
	env: NodeJS.ProcessEnv = { GH_TOKEN: TOKEN },
): CiCommandContext {
	return {
		args,
		flags: { json: false, cwd: "/work" },
		emitProgress: () => undefined,
		env,
		fetch: github.fetch,
		now: () => 0,
		localRepository: async (repo) => ({
			root: "/work",
			repository: repo ?? REPO,
		}),
	};
}

describe("hobo ci rerun --reroute", () => {
	it("is asked for only with --reroute", () => {
		expect(wantsReroute(["77", "--reroute"])).toBe(true);
		expect(wantsReroute(["77"])).toBe(false);
	});

	it("R12: re-runs the relay job, not the failed job, so the relay decides again", async () => {
		const github = fakeGithub();
		const result = await CI_RERUN_REROUTE_COMMAND.run(
			context(["77", "--reroute"], github),
		);
		expect(result.ok).not.toBe(false);
		expect(result.data).toEqual({
			repository: REPO,
			runId: 77,
			attempt: 2,
			relayJob: { id: 11, name: "route" },
		});
		expect(result.message).toContain("relay job route runs again as attempt 2");
		const writes = github.requests.filter(
			(request) => request.method === "POST",
		);
		expect(writes.map((request) => request.path)).toEqual([
			`https://api.github.com/repos/${REPO}/actions/jobs/11/rerun`,
		]);
		expect(
			github.requests.some((request) =>
				request.path.includes("rerun-failed-jobs"),
			),
		).toBe(false);
		expect(
			github.requests.every((request) => request.auth === `Bearer ${TOKEN}`),
		).toBe(true);
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	it("uses GITHUB_API_URL and GITHUB_TOKEN as a workflow sets them", async () => {
		const origin = "https://ghe.example.test";
		const github = fakeGithub({ origin });
		const result = await CI_RERUN_REROUTE_COMMAND.run(
			context(["77", "--reroute"], github, {
				GITHUB_TOKEN: TOKEN,
				GITHUB_API_URL: `${origin}/`,
			}),
		);
		expect(result.ok).not.toBe(false);
		expect(
			github.requests.every((request) => request.path.startsWith(origin)),
		).toBe(true);
		const refused = await CI_RERUN_REROUTE_COMMAND.run(
			context(["77", "--reroute"], fakeGithub(), {
				GH_TOKEN: TOKEN,
				GITHUB_API_URL: "http://plain.example.test",
			}),
		);
		expect(refused).toMatchObject({ ok: false, code: "HOBO_CI_RERUN_USAGE" });
	});

	it("picks one relay with --job when a run has several", async () => {
		const jobs = [
			{ id: 11, name: "route", labels: ["hobo-relay"] },
			{ id: 13, name: "route-docs", labels: ["hobo-relay"] },
			{ id: 12, name: "build", labels: ["ubuntu-24.04"] },
		];
		const several = await CI_RERUN_REROUTE_COMMAND.run(
			context(["77", "--reroute"], fakeGithub({ jobs })),
		);
		expect(several).toMatchObject({
			ok: false,
			code: "HOBO_CI_RERUN_SEVERAL_RELAYS",
		});
		expect(several.message).toContain("route, route-docs");
		const github = fakeGithub({ jobs });
		const picked = await CI_RERUN_REROUTE_COMMAND.run(
			context(["77", "--reroute", "--job", "route-docs"], github),
		);
		expect(picked.data).toMatchObject({ relayJob: { id: 13 } });
	});

	it("refuses what it cannot reroute, and says why", async () => {
		const run = (
			args: readonly string[],
			github = fakeGithub(),
			env?: NodeJS.ProcessEnv,
		) => CI_RERUN_REROUTE_COMMAND.run(context(args, github, env));
		expect(await run(["77"])).toMatchObject({ code: "HOBO_CI_RERUN_USAGE" });
		expect(await run(["--reroute"])).toMatchObject({
			code: "HOBO_CI_RERUN_USAGE",
		});
		expect(await run(["abc", "--reroute"])).toMatchObject({
			code: "HOBO_CI_RERUN_USAGE",
		});
		expect(await run(["77", "--reroute", "--nope"])).toMatchObject({
			code: "HOBO_CI_RERUN_USAGE",
		});
		expect(await run(["77", "--reroute"], fakeGithub(), {})).toMatchObject({
			code: "HOBO_CI_RERUN_NO_TOKEN",
		});
		expect(await run(["78", "--reroute"])).toMatchObject({
			code: "HOBO_CI_RERUN_NOT_FOUND",
		});
		const running = fakeGithub({ status: "in_progress" });
		expect(await run(["77", "--reroute"], running)).toMatchObject({
			code: "HOBO_CI_RERUN_RUNNING",
		});
		expect(running.requests.some((request) => request.method === "POST")).toBe(
			false,
		);
		expect(
			await run(
				["77", "--reroute"],
				fakeGithub({
					jobs: [{ id: 12, name: "build", labels: ["ubuntu-24.04"] }],
				}),
			),
		).toMatchObject({ code: "HOBO_CI_RERUN_NO_RELAY" });
		const refused = await run(
			["77", "--reroute"],
			fakeGithub({ rerunStatus: 403 }),
		);
		expect(refused).toMatchObject({ code: "HOBO_CI_RERUN_REFUSED" });
		expect(refused.message).toContain("Resource not accessible by integration");
	});

	it("R12: is reached from the CLI as hobo ci rerun <run> --reroute", async () => {
		const github = fakeGithub();
		const cli = createHoboCli({
			commands: {
				ci: createCiCommand({
					env: { GH_TOKEN: TOKEN },
					fetch: github.fetch,
					git: async (args) =>
						args[0] === "rev-parse" ? "/work" : `git@github.com:${REPO}.git`,
				}),
			},
		});
		const result = await cli.run(["ci", "rerun", "77", "--reroute"], {
			cwd: "/work",
		});
		expect(result.stderr).toBe("");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("relay job route runs again as attempt 2");
		expect(
			github.requests
				.filter((request) => request.method === "POST")
				.map((request) => request.path),
		).toEqual([`https://api.github.com/repos/${REPO}/actions/jobs/11/rerun`]);
	});

	it("reads every page of a large run's jobs to find its relay", async () => {
		const jobs: FakeJob[] = Array.from({ length: 140 }, (_, index) => ({
			id: 100 + index,
			name: `build (${index})`,
			labels: ["ubuntu-24.04"],
		}));
		jobs.push({ id: 11, name: "route", labels: ["hobo-relay"] });
		const result = await CI_RERUN_REROUTE_COMMAND.run(
			context(["77", "--reroute"], fakeGithub({ jobs })),
		);
		expect(result.ok).not.toBe(false);
		expect(result.data).toMatchObject({ relayJob: { id: 11 } });
	});

	it("never takes route-lint or relay-tests for a relay, and prefers the relay label", async () => {
		const named = await CI_RERUN_REROUTE_COMMAND.run(
			context(
				["77", "--reroute"],
				fakeGithub({
					jobs: [
						{ id: 21, name: "route-lint", labels: ["ubuntu-24.04"] },
						{ id: 22, name: "relay-tests", labels: ["ubuntu-24.04"] },
						{ id: 11, name: "route", labels: ["ubuntu-24.04"] },
					],
				}),
			),
		);
		expect(named.data).toMatchObject({ relayJob: { id: 11 } });
		const labelled = await CI_RERUN_REROUTE_COMMAND.run(
			context(
				["77", "--reroute"],
				fakeGithub({
					jobs: [
						{ id: 11, name: "route", labels: ["ubuntu-24.04"] },
						{ id: 31, name: "dispatch", labels: ["hobo-relay"] },
					],
				}),
			),
		);
		expect(labelled.data).toMatchObject({ relayJob: { id: 31 } });
	});
});
