import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Before, Given, Then, When } from "@cucumber/cucumber";
import { createHoboCli } from "../../../packages/cli/src/index.js";
import {
	type MinutesUsage,
	parseRunnerRouteEvent,
} from "../../../packages/ci/src/index.js";
import { CI_SIGNAL_IDS } from "../../../packages/ci/src/insights/index.js";
import { SIGNAL_DIMENSIONS } from "../../../packages/ci/src/insights/breakdown.js";
import { SqliteRouteJournal } from "../../../packages/ci/src/runner-order/journal-sqlite.js";
import {
	InMemoryInsightStore,
	InMemoryMinutesReader,
} from "../../../packages/ci/src/runner-order/testing.js";
import { CI_ACTIVITY_COMMAND } from "../../../packages/hobo/src/ci-activity.js";
import { createCiCommand } from "../../../packages/hobo/src/ci-command.js";
import { CI_PERFORMANCE_COMMAND } from "../../../packages/hobo/src/ci-performance.js";
import { CI_USAGE_COMMAND } from "../../../packages/hobo/src/ci-usage.js";
import {
	HISTORY_REPOSITORY,
	twoWeeksOfRuns,
} from "../../../packages/hobo/test/support/ci-insight-history.js";
import {
	FAKE_RELAY_ORIGIN,
	FAKE_RELAY_TOKEN,
	type FakeReadApi,
	fakeReadApiFetch,
} from "../../../packages/hobo/test/support/ci-read-api-fake.js";

const DAY = 86_400_000;
const NOW = 1_763_337_600_000;
const ACCOUNT = "acct-1";

type InsightCommandState = {
	api: FakeReadApi;
	envelope: Readonly<{ ok: boolean; data: InsightData }> | undefined;
	text: string;
};

type InsightData = Readonly<{
	entries: readonly Readonly<{
		atMs: number;
		step: string;
		runner: string;
		why: string;
		passedOver: readonly string[];
	}>[];
	report: Readonly<{
		billedMinutes: number;
		shortJobs: number;
		wasteMinutes: number;
		relayJobsAnswered: number;
		relaySavedMinutes: number;
		included: Readonly<{
			usedMinutes: number;
			includedMinutes: number;
			burnPerDay: number;
		}>;
	}>;
	times: Readonly<{
		workflows: readonly Readonly<{ workflow: string }>[];
		jobs: readonly Readonly<{ job: string; fastest?: string }>[];
		runners: readonly Readonly<{ key: string }>[];
	}>;
	againstBaseline: Readonly<{
		baseline: string;
		runners: readonly Readonly<{ key: string; medianRatio: number }>[];
	}>;
	signals: Readonly<{
		signals: Readonly<{ signals: readonly Readonly<{ id: string }>[] }>;
		by: Readonly<{ [dimension: string]: readonly Readonly<{ key: string }>[] }>;
		trend: readonly Readonly<{ day: string }>[];
	}>;
	thresholds: Readonly<{
		minMinutes: number;
		signals: readonly Readonly<{ id: string; counts: string }>[];
	}>;
}>;

let state: InsightCommandState;

function readApi(init: Partial<FakeReadApi>): FakeReadApi {
	return {
		accountId: ACCOUNT,
		repositories: [{ name: HISTORY_REPOSITORY, public: false }],
		journal: undefined,
		insights: undefined,
		minutes: undefined,
		nowMs: () => NOW,
		asked: [],
		...init,
	};
}

async function storedRuns(): Promise<InMemoryInsightStore> {
	const insights = new InMemoryInsightStore();
	for (const run of twoWeeksOfRuns(NOW)) await insights.ingest(run);
	await insights.ingest({
		id: 2000,
		attempt: 1,
		repository: HISTORY_REPOSITORY,
		workflow: "PR title",
		workflowPath: ".github/workflows/pr-title.yml",
		event: "pull_request",
		branch: "feature",
		defaultBranch: "main",
		headSha: "b".repeat(40),
		actor: "octocat",
		conclusion: "success",
		createdAtMs: NOW - DAY,
		completedAtMs: NOW - DAY + 2_000,
		jobs: [
			{
				id: 20_000,
				name: "relay",
				labels: ["hobo-relay"],
				runnerName: "hobo-relay",
				conclusion: "success",
				queuedAtMs: NOW - DAY,
				startedAtMs: NOW - DAY + 1_000,
				completedAtMs: NOW - DAY + 2_000,
				steps: [],
				billed: false,
				relay: true,
			},
		],
	});
	return insights;
}

Before({ tags: "@I01 or @I03 or @I04 or @I05" }, () => {
	state = { api: readApi({}), envelope: undefined, text: "" };
});

Given("route decisions journaled over the last 100 days", async () => {
	let clock = NOW - 100 * DAY;
	const journal = new SqliteRouteJournal(new DatabaseSync(":memory:"), {
		nowMs: () => clock,
		retentionMs: 365 * DAY,
	});
	for (let day = 100; day >= 1; day -= 1) {
		clock = NOW - day * DAY;
		const depot = day % 2 === 0;
		await journal.record(
			parseRunnerRouteEvent(
				JSON.stringify({
					type: "runner.route.Decided",
					accountId: ACCOUNT,
					atMs: clock,
					request: {
						repository: HISTORY_REPOSITORY,
						private: true,
						event: "push",
						runId: day,
						runAttempt: 1,
						job: "route",
					},
					decision: {
						outcome: "routed",
						runner: depot ? "depot-ubuntu-24.04" : "ubuntu-latest",
						step: depot ? "depot" : "github",
						skipped: [{ key: "fleet", reason: "fleet_full", detail: "" }],
					},
					mode: "relay",
					node: "node-1",
					jobId: `job-${day}`,
				}),
			),
		);
	}
	clock = NOW;
	assert.equal(
		(
			await journal.decisions({
				accountId: ACCOUNT,
				repository: undefined,
				sinceMs: 0,
				limit: 1000,
			})
		).length,
		100,
	);
	state.api = readApi({ journal });
});

Given("a month of stored runs and the owner's included minutes", async () => {
	const included: MinutesUsage = {
		usedMinutes: 1_200,
		includedMinutes: 3_000,
		burnPerHour: 2,
	};
	state.api = readApi({
		insights: await storedRuns(),
		minutes: new InMemoryMinutesReader(new Map([["octo", included]])),
	});
});

Given("stored runs on two runner types", async () => {
	state.api = readApi({ insights: await storedRuns() });
});

Given("stored runs over two weeks", async () => {
	state.api = readApi({ insights: await storedRuns() });
});

async function runHobo(command: string): Promise<void> {
	const words = command.split(/\s+/u);
	assert.equal(words[0], "hobo");
	const cli = createHoboCli({
		commands: {
			ci: createCiCommand({
				env: {
					HOBO_CI_RELAY_URL: FAKE_RELAY_ORIGIN,
					HOBO_CI_ACCOUNT_TOKEN: FAKE_RELAY_TOKEN,
				},
				now: () => NOW,
				fetch: fakeReadApiFetch(state.api),
				commands: [
					CI_ACTIVITY_COMMAND,
					CI_USAGE_COMMAND,
					CI_PERFORMANCE_COMMAND,
				],
			}),
		},
	});
	const args = words.slice(1);
	const text = await cli.run(args, { cwd: tmpdir() });
	assert.equal(text.exitCode, 0, text.stdout + text.stderr);
	state.text = text.stdout;
	const json = await cli.run([...args, "--json"], { cwd: tmpdir() });
	state.envelope = JSON.parse(json.stdout);
}

When("{string} runs", async (command: string) => {
	await runHobo(command);
});

When("the signals are read", async () => {
	await runHobo("hobo ci performance");
});

function data(): InsightData {
	assert.ok(state.envelope?.ok, "the command answered");
	return state.envelope.data;
}

Then(
	"it lists each matching job with its runner and the decision's reason",
	() => {
		const entries = data().entries;
		assert.ok(entries.length > 0);
		for (const entry of entries) {
			assert.equal(entry.step, "depot");
			assert.equal(entry.runner, "depot-ubuntu-24.04");
			assert.equal(entry.why, "Routed to depot-ubuntu-24.04 (depot).");
			assert.ok(entry.passedOver.some((line) => line.startsWith("fleet:")));
		}
		assert.match(state.text, /ran on depot-ubuntu-24\.04 \(depot\)/u);
		assert.match(state.text, /passed over fleet:/u);
	},
);

Then("nothing older than 90 days", async () => {
	const entries = data().entries;
	assert.equal(entries.length, 45);
	for (const entry of entries) assert.ok(entry.atMs >= NOW - 90 * DAY);
	await runHobo("hobo ci activity --since 30d --runner depot");
	assert.equal(data().entries.length, 15);
});

Then(
	"it shows minutes used against the included amount, the burn rate, short jobs and minutes saved by checks",
	() => {
		const report = data().report;
		assert.equal(report.included.usedMinutes, 1_200);
		assert.equal(report.included.includedMinutes, 3_000);
		assert.equal(report.included.burnPerDay, 48);
		assert.equal(report.shortJobs, 15);
		assert.ok(report.wasteMinutes > 0);
		assert.equal(report.relayJobsAnswered, 1);
		assert.equal(report.relaySavedMinutes, 1);
		assert.match(state.text, /1200 min of 3000 min used/u);
		assert.match(state.text, /15 billed jobs under a minute/u);
		assert.match(state.text, /1 relay jobs answered without a billed minute/u);
	},
);

Then("it compares workflows, jobs and runners", () => {
	const times = data().times;
	assert.deepEqual(
		times.workflows.map((row) => row.workflow).sort(),
		["CI", "PR title"],
	);
	const test = times.jobs.find((job) => job.job === "test");
	assert.equal(test?.fastest, "depot-ubuntu-24.04");
	assert.deepEqual(
		times.runners.map((row) => row.key).sort(),
		["depot-ubuntu-24.04", "ubuntu-latest"],
	);
	assert.match(state.text, /workflows\n/u);
	assert.match(state.text, /jobs on more than one runner\n/u);
	assert.match(state.text, /runners\n/u);
});

Then("each runner is compared with the GitHub-hosted baseline", () => {
	const against = data().againstBaseline;
	assert.equal(against.baseline, "ubuntu-latest");
	assert.deepEqual(against.runners, [
		{ key: "depot-ubuntu-24.04", jobs: 1, medianRatio: 2 },
	]);
	assert.match(
		state.text,
		/against ubuntu-latest\n {2}depot-ubuntu-24\.04 {2}2\.00x as fast/u,
	);
});

Then(
	"each of the nine signals has its threshold, a breakdown and a trend",
	() => {
		const { signals, thresholds } = data();
		assert.deepEqual(
			signals.signals.signals.map((signal) => signal.id),
			[...CI_SIGNAL_IDS],
		);
		assert.deepEqual(
			thresholds.signals.map((entry) => entry.id),
			[...CI_SIGNAL_IDS],
		);
		for (const entry of thresholds.signals) assert.ok(entry.counts.length > 0);
		assert.equal(thresholds.minMinutes, 30);
		for (const dimension of SIGNAL_DIMENSIONS)
			assert.ok((signals.by[dimension] ?? []).length > 0, dimension);
		assert.equal(signals.trend.length, 14);
		for (const id of CI_SIGNAL_IDS) assert.match(state.text, new RegExp(id, "u"));
		assert.match(state.text, /by repository: /u);
		assert.match(state.text, /per day: /u);
	},
);
