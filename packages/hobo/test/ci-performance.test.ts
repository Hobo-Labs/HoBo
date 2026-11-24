import { tmpdir } from "node:os";
import { CI_SIGNAL_IDS } from "@hobo/ci/insights";
import { SIGNAL_DIMENSIONS } from "@hobo/ci/insights/breakdown";
import { InMemoryInsightStore } from "@hobo/ci/runner-order/testing";
import { createHoboCli } from "@hobo/cli";
import { describe, expect, it } from "vitest";
import { createCiCommand } from "../src/ci-command.js";
import { CI_COMMANDS } from "../src/ci-commands.js";
import {
	CI_PERFORMANCE_COMMAND,
	runnersAgainstBaseline,
	signalThreshold,
} from "../src/ci-performance.js";
import {
	fakeGithub,
	HISTORY_REPOSITORY,
	twoWeeksOfRuns,
} from "./support/ci-insight-history.js";
import {
	FAKE_RELAY_ORIGIN,
	type FakeReadApi,
	fakeOwnerCredentials,
	fakeReadApiFetch,
} from "./support/ci-read-api-fake.js";
import { routeGithub, withInstallation } from "./support/github-app-fake.js";

const NOW = 1_763_337_600_000;
const RELAY_ENV = { HOBO_CI_RELAY_URL: FAKE_RELAY_ORIGIN };

async function readApi(init: Partial<FakeReadApi> = {}): Promise<FakeReadApi> {
	const insights = new InMemoryInsightStore();
	for (const run of twoWeeksOfRuns(NOW)) await insights.ingest(run);
	return {
		accountId: "acct-1",
		repositories: [{ name: HISTORY_REPOSITORY, public: false }],
		journal: undefined,
		insights,
		minutes: undefined,
		nowMs: () => NOW,
		asked: [],
		...init,
	};
}

async function run(
	args: readonly string[],
	options: Readonly<{
		api?: FakeReadApi;
		env?: NodeJS.ProcessEnv;
		github?: typeof fetch;
	}> = {},
) {
	const api = options.api ?? (await readApi());
	const relay = fakeReadApiFetch(api);
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: options.env ?? RELAY_ENV,
				ownerCredentials: (cwd) =>
					withInstallation(fakeOwnerCredentials()(cwd)),
				now: () => NOW,
				fetch:
					options.github === undefined
						? relay
						: routeGithub(options.github, relay),
				git: async () => tmpdir(),
				commands: [CI_PERFORMANCE_COMMAND],
			}),
		},
	});
	const result = await cli.run(["ci", "performance", ...args], {
		cwd: tmpdir(),
	});
	return { ...result, output: result.stdout + result.stderr };
}

async function runJson(
	args: readonly string[],
	options: Parameters<typeof run>[1] = {},
) {
	const result = await run([...args, "--json"], options);
	return { ...result, envelope: JSON.parse(result.stdout) };
}

describe("hobo ci performance", () => {
	it("is wired into the hobo ci command table", () => {
		expect(CI_COMMANDS.map((command) => command.name)).toContain("performance");
	});

	it("compares workflows, jobs and runners, and each runner with ubuntu-latest", async () => {
		const api = await readApi();
		const result = await run([], { api });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("from the relay");
		expect(result.stdout).toMatch(/workflows\n {2}CI {2}15 runs/u);
		expect(result.stdout).toContain("CI / test  depot-ubuntu-24.04 3m00s");
		expect(result.stdout).toContain("ubuntu-latest 6m00s");
		expect(result.stdout).toContain("fastest depot-ubuntu-24.04");
		expect(result.stdout).toMatch(/runners\n {2}ubuntu-latest {2}23 jobs/u);
		expect(result.stdout).toContain(
			"against ubuntu-latest\n  depot-ubuntu-24.04  2.00x as fast over 1 job",
		);
		expect(api.asked.map((path) => path.split("?")[0])).toEqual([
			"/v1/accounts/self/job-times",
			"/v1/accounts/self/signals",
		]);
	});

	it("shows the nine signals with their thresholds, a breakdown and a per-day trend", async () => {
		const result = await runJson([]);
		const data = result.envelope.data;
		expect(
			data.signals.signals.signals.map((signal: { id: string }) => signal.id),
		).toEqual([...CI_SIGNAL_IDS]);
		expect(data.thresholds.signals).toHaveLength(9);
		expect(data.thresholds.minMinutes).toBe(30);
		for (const dimension of SIGNAL_DIMENSIONS)
			expect(data.signals.by[dimension].length).toBeGreaterThan(0);
		expect(data.signals.trend).toHaveLength(14);
		const queue = data.signals.signals.signals.find(
			(signal: { id: string }) => signal.id === "queue-waits",
		);
		expect(queue.occurrences).toBeGreaterThan(0);
		const text = await run([]);
		for (const id of CI_SIGNAL_IDS) expect(text.stdout).toContain(id);
		expect(text.stdout).toContain("jobs that waited over 1 min for a runner");
		expect(text.stdout).toContain("by person: ");
		expect(text.stdout).toContain("per day: ");
	});

	it("computes the same reports from GitHub's history as the relay does from its own", async () => {
		const github = fakeGithub(twoWeeksOfRuns(NOW));
		const fromGithub = await runJson(
			["--source", "github", "--repo", HISTORY_REPOSITORY],
			{ env: {}, github: github.fetch },
		);
		expect(fromGithub.exitCode).toBe(0);
		const fromRelay = await runJson([]);
		expect(fromGithub.envelope.data.times).toEqual(
			fromRelay.envelope.data.times,
		);
		expect(fromGithub.envelope.data.signals).toEqual(
			fromRelay.envelope.data.signals,
		);
		expect(fromGithub.envelope.data.againstBaseline).toEqual(
			fromRelay.envelope.data.againstBaseline,
		);
	});

	it("points at --source github when the relay keeps no run history", async () => {
		const result = await runJson([], {
			api: await readApi({ insights: undefined }),
		});
		expect(result.envelope.code).toBe("HOBO_CI_NOT_STORED_HERE");
		expect(result.envelope.message).toContain("--source github");
	});

	it("reports a relay answer that is not the read API's record", async () => {
		const cli = createHoboCli({
			commands: {
				ci: createCiCommand({
					env: RELAY_ENV,
					ownerCredentials: fakeOwnerCredentials(),
					now: () => NOW,
					fetch: async () => Response.json({ workflows: "many" }),
					commands: [CI_PERFORMANCE_COMMAND],
				}),
			},
		});
		const result = await cli.run(["ci", "performance", "--json"], {
			cwd: tmpdir(),
		});
		expect(JSON.parse(result.stdout).code).toBe("HOBO_CI_RELAY_ERROR");
	});
});

describe("performance helpers", () => {
	it("takes each runner's median speedup over the jobs it shares with the baseline", () => {
		const job = (ratio: number) => ({
			job: "test",
			workflow: "CI",
			runners: [],
			speedup: [{ key: "depot", ratio }],
		});
		expect(runnersAgainstBaseline([job(1.5), job(3), job(2)])).toEqual([
			{ key: "depot", jobs: 3, medianRatio: 2 },
		]);
		expect(runnersAgainstBaseline([])).toEqual([]);
	});

	it("words every signal's threshold", () => {
		for (const id of CI_SIGNAL_IDS) expect(signalThreshold(id)).not.toBe("");
		expect(signalThreshold("wide-fanout")).toContain("10 or more jobs");
	});
});
