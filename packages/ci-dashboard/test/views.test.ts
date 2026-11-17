/**
 * The five views as markup: what each shows, in what order, and that every
 * value is escaped. The browser test drives the same markup in a real page.
 */
import { describe, expect, it } from "vitest";
import {
	blankQuestion,
	editOrderUrl,
	type JobTimesReport,
	renderHistory,
	renderPerformance,
	renderRouter,
	renderRunners,
	renderSignals,
	type SignalReport,
	whatIf,
} from "../src/index.js";
import {
	decided,
	failedRun,
	machine,
	NOW,
	order,
	REPOSITORY,
} from "./support/records.js";

const ADOPTED = "github:runner-labels";

describe("Runners", () => {
	const html = renderRunners({
		nowMs: NOW,
		machines: [
			machine({ id: "m-ok", name: "studio" }),
			machine({ id: "m-off", name: "laptop", lastSeenMs: NOW - 3_600_000 }),
			machine({ id: "m-paused", name: "tower", paused: true }),
			machine({ id: "m-full", name: "mini", slots: 1, busy: 1 }),
			machine({
				id: "github-runner-7",
				name: "rack-7",
				signerKeyId: ADOPTED,
				isolation: "host",
				slots: 1,
			}),
		],
		routes: [
			decided({
				minutesAgo: 5,
				step: "github",
				runner: "ubuntu-24.04",
				skipped: [{ key: "fleet", reason: "fleet_full" }],
			}),
			decided({ minutesAgo: 9, step: "fleet", runner: "hobo" }),
		],
	});

	it("puts what needs attention first, worst first", () => {
		const attention = html.indexOf("Needs attention (3)");
		expect(attention).toBeGreaterThanOrEqual(0);
		expect(attention).toBeLessThan(html.indexOf("Machines ("));
		expect(html).toContain(
			"<strong>laptop</strong> <code>m-off</code>: offline since",
		);
		expect(html).toContain(
			"<strong>tower</strong> <code>m-paused</code>: paused",
		);
		expect(html).toContain("every slot busy (1 of 1)");
		expect(html).not.toContain("<strong>studio</strong> <code>m-ok</code>:");
	});

	it("lists connected machines and adopted runners apart", () => {
		expect(html).toContain("Machines (4)");
		expect(html).toContain("Adopted runners (1)");
		expect(html).toContain("rack-7");
		// An adopted runner runs on its host by nature; that is not a problem to flag.
		expect(html).not.toContain(
			"rack-7</strong> <code>github-runner-7</code>: runs jobs on the host",
		);
	});

	it("summarises the fleet from the route journal", () => {
		expect(html).toContain("<dt>Took</dt><dd>1 jobs</dd>");
		expect(html).toContain("<dt>Passed over, full</dt><dd>1</dd>");
	});

	it("orders attention by how bad it is, not by machine", () => {
		const shown = renderRunners({
			nowMs: NOW,
			machines: [
				machine({ id: "a-full", slots: 1, busy: 1 }),
				machine({ id: "b-paused", paused: true }),
				machine({ id: "c-off", lastSeenMs: 1 }),
			],
			routes: [],
		});
		const offline = shown.indexOf("<code>c-off</code>: offline");
		const paused = shown.indexOf("<code>b-paused</code>: paused");
		const full = shown.indexOf("<code>a-full</code>: every slot busy");
		expect(offline).toBeGreaterThan(0);
		expect(offline).toBeLessThan(paused);
		expect(paused).toBeLessThan(full);
	});

	it("says when nothing needs attention", () => {
		expect(
			renderRunners({
				nowMs: NOW,
				machines: [machine({ id: "m-a" })],
				routes: [],
			}),
		).toContain("Nothing needs attention");
	});
});

describe("Router", () => {
	const committed = order(
		JSON.stringify({
			steps: [
				{ key: "machine" },
				{ key: "github", minutesLimitPercent: 80 },
				{ key: "depot", spendLimitUsd: 50 },
				{ key: "github" },
			],
		}),
	);
	const routes = [
		decided({
			minutesAgo: 2,
			step: "github",
			runner: "ubuntu-24.04",
			skipped: [
				{ key: "machine", reason: "machine_full", detail: "studio" },
				{
					key: "depot",
					reason: "provider_unhealthy",
					detail: "depot-ubuntu-24.04",
				},
			],
		}),
	];
	const question = blankQuestion(REPOSITORY, committed.order);
	const html = renderRouter({
		nowMs: NOW,
		order: committed,
		routes,
		question,
		answer: undefined,
	});

	it("shows the committed order with its limits and health", () => {
		expect(html).toContain("Runner order · octo/app");
		expect(html).toContain("while under 80% of included minutes");
		expect(html).toContain("while under $50 this month");
		expect(html).toMatch(
			/data-state="spark"><span class="lamp" aria-hidden="true"><\/span>passed over 2 min ago: it has stopped starting jobs/u,
		);
		expect(html).toContain("took a job 2 min ago");
	});

	it("shows recent decisions with every step passed over", () => {
		expect(html).toContain("Routed to ubuntu-24.04 (github).");
		expect(html).toContain("<li>machine: every machine is busy (studio)</li>");
		expect(html).toContain(
			"<li>depot: it has stopped starting jobs (depot-ubuntu-24.04)</li>",
		);
	});

	it("edits the order through a pull request on GitHub, never in place", () => {
		const url = editOrderUrl(REPOSITORY, undefined);
		expect(url).toBe("https://github.com/octo/app/edit/HEAD/.hobo/ci.json");
		expect(html).toContain(`href="${url}"`);
		expect(html).toContain("nothing changes until the pull request merges");
		expect(html).not.toMatch(/method="post"/iu);
	});

	it("renders the what-if answer it is given", () => {
		const answer = whatIf(
			committed.order,
			{ ...question, labels: new Map([["github", "ubuntu-24.04"]]) },
			[],
			NOW,
		);
		const answered = renderRouter({
			nowMs: NOW,
			order: committed,
			routes,
			question,
			answer,
		});
		expect(answered).toContain(
			'<div id="what-if-answer" class="answer" role="status" tabindex="-1">',
		);
		expect(answered).toContain("Routed to ubuntu-24.04 (github).");
	});

	it("shows a what-if refusal as a status line, and asks for digits in Started by", () => {
		const refused = renderRouter({
			nowMs: NOW,
			order: committed,
			routes,
			question: { ...question, startedBy: "<abc>" },
			answer: { refused: "Started by must be a GitHub user id <digits>." },
		});
		expect(refused).toContain(
			'<div id="what-if-answer" class="answer" role="status" tabindex="-1" data-state="refused">',
		);
		expect(refused).toContain(
			"Started by must be a GitHub user id &lt;digits&gt;.",
		);
		expect(refused).toContain('value="&lt;abc&gt;"');
		expect(refused).toContain('inputmode="numeric" pattern="[0-9]{0,20}"');
	});

	it("says loudly when the committed order does not parse, and disables the walk", () => {
		const broken = order(
			JSON.stringify({ steps: [{ key: "github" }] }),
			'unknown runner step "gpu"',
		);
		const shown = renderRouter({
			nowMs: NOW,
			order: broken,
			routes: [],
			question,
			answer: undefined,
		});
		expect(shown).toContain('role="alert"');
		expect(shown).toContain("unknown runner step &quot;gpu&quot;");
		expect(shown).toContain("<fieldset disabled>");
	});
});

describe("History", () => {
	const run = failedRun();
	const html = renderHistory({ nowMs: NOW, runs: [run], selected: run });

	it("lists runs with a link to each attempt", () => {
		expect(html).toContain('href="#/history/octo/app/300/2"');
		expect(html).toContain("octo/app #300 attempt 2");
	});

	it("says why a run attempt the address names is not opened", () => {
		const shown = renderHistory({
			nowMs: NOW,
			runs: [run],
			selected: undefined,
			unfound: { repository: "octo/<other>", id: 9, attempt: 1 },
		});
		expect(shown).toContain(
			'<h2 id="run-heading">octo/&lt;other&gt; #9 attempt 1</h2>',
		);
		expect(shown).toContain(
			"This run attempt is not among the newest 50 stored runs of octo/&lt;other&gt;, so it cannot be opened here.",
		);
	});

	it("shows jobs, step timings and the diagnosis of a failure", () => {
		expect(html).toContain("<h3>unit tests</h3>");
		expect(html).toContain("Run vitest");
		expect(html).toContain("9m 00s");
		expect(html).toContain(
			"Failed at &quot;Run vitest&quot;: looks like a test failure; a re-run will likely fail the same way.",
		);
		expect(html).toContain('data-kind="test"');
		// The job that passed is not diagnosed.
		expect(html.match(/class="diagnosis"/gu)).toHaveLength(1);
	});
});

describe("Performance", () => {
	const report: JobTimesReport = {
		sinceMs: NOW - 30 * 86_400_000,
		runs: 4,
		workflows: [
			{
				workflow: "CI",
				runs: 4,
				successRate: 0.75,
				medianMs: 200_000,
				p90Ms: 260_000,
				medianWaitMs: 6000,
				slowestJob: "test",
			},
		],
		jobs: [
			{
				job: "test",
				workflow: "CI",
				runners: [
					{
						key: "ubuntu-latest",
						runs: 2,
						medianRunMs: 180_000,
						p90RunMs: 190_000,
						confidence: "few",
					},
					{
						key: "depot-ubuntu-24.04",
						runs: 2,
						medianRunMs: 90_000,
						p90RunMs: 95_000,
						confidence: "few",
					},
				],
				fastest: "depot-ubuntu-24.04",
				speedup: [{ key: "depot-ubuntu-24.04", ratio: 2 }],
			},
		],
		runners: [
			{
				key: "ubuntu-latest",
				jobs: 2,
				started: 2,
				startedShare: 1,
				medianWaitMs: 5000,
				medianRunMs: 180_000,
				p90RunMs: 190_000,
				successRate: 0.5,
			},
		],
	};
	const html = renderPerformance(report);

	it("compares workflows, jobs and runners, each against ubuntu-latest", () => {
		expect(html).toContain("Times by workflow");
		expect(html).toContain("Times by job and runner");
		expect(html).toContain("Times by runner");
		expect(html).toContain("75%");
		expect(html).toContain(
			'<code>depot-ubuntu-24.04</code> <span class="badge">fastest</span>',
		);
		expect(html).toContain("2×");
	});
});

describe("Signals", () => {
	const ids = [
		"no-concurrency",
		"same-commit",
		"short-jobs",
		"queue-waits",
		"slowest-job",
		"flaky-jobs",
		"runner-failures",
		"docs-changes",
		"wide-fanout",
	];
	const report: SignalReport = {
		sinceMs: NOW - 30 * 86_400_000,
		runs: 3,
		signals: {
			totalJobMinutes: 40,
			signals: ids.map((id) => ({
				id,
				area: "cost",
				minutes: id === "queue-waits" ? 12 : 0,
				occurrences: id === "queue-waits" ? 4 : 0,
				shown: id === "queue-waits",
				rows:
					id === "queue-waits"
						? [{ key: "CI / <test>", minutes: 12, occurrences: 4 }]
						: [],
			})),
		},
		by: {
			person: [{ key: "octocat", runs: 3, minutes: 12, jobMinutes: 40 }],
			repository: [],
		},
		trend: [
			{
				day: "2026-11-15",
				key: "2026-11-15",
				runs: 1,
				minutes: 0,
				jobMinutes: 10,
			},
			{
				day: "2026-11-16",
				key: "2026-11-16",
				runs: 2,
				minutes: 12,
				jobMinutes: 30,
			},
		],
	};
	const html = renderSignals(report);

	it("shows all nine signals, the breakdown and the trend", () => {
		expect(html.match(/<li class="signal"/gu)).toHaveLength(9);
		expect(html).toContain("Jobs wait more than a minute for a runner");
		expect(html).toContain("Signal minutes by person");
		expect(html).toContain('aria-label="Signal minutes per day"');
		expect(html.match(/class="bar"/gu)).toHaveLength(2);
	});

	it("escapes every value it shows", () => {
		expect(html).toContain("<code>CI / &lt;test&gt;</code>");
		expect(html).not.toContain("<test>");
	});
});
