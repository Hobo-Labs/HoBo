import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
	ABSENT_SLIP_WHYS,
	evaluate,
	type HealthReport,
	h2Breaches,
	type JsonValue,
	main,
	type PreviousReport,
	parseAnnotations,
	parseJobs,
	parseJson,
	parsePreviousReport,
	parseRouteNotice,
	parseRuns,
	REQUEST_BUDGET,
	type RunPages,
	readJsonFromZip,
	renderReport,
	routeEvidence,
	SLIP_FALLBACK_PREFIX,
} from "../ci/ci-health.mts";
import {
	ABSENT_SLIP_WHYS as ROUTE_ABSENT_SLIP_WHYS,
	SLIP_FALLBACK_PREFIX as ROUTE_SLIP_FALLBACK_PREFIX,
} from "../ci/route-runner.mts";

/**
 * A recorded window, hand-copied from the GitHub REST shapes: the run list
 * page, each run's jobs page and the route check runs' annotations.
 */
type Recorded = Readonly<{
	now: string;
	runs: readonly JsonValue[];
	jobs: Readonly<Record<string, readonly JsonValue[]>>;
	annotations: Readonly<Record<string, readonly JsonValue[]>>;
}>;

const fixtureDir = join(import.meta.dirname, "fixtures", "ci-health");
function load(name: string): Recorded {
	// SAFETY: the fixture files are written in the Recorded shape above.
	return JSON.parse(readFileSync(join(fixtureDir, name), "utf8")) as Recorded;
}
const clear = load("clear-window.json");
const breach = load("breach-window.json");

const REPOSITORY = "Hobo-Labs/HoBo";
const THRESHOLDS = { stallMinutes: 30, paidMinutesPerWindow: 150 };

function pagesOf(recorded: Recorded): RunPages[] {
	return parseRuns({ workflow_runs: recorded.runs }).map((run) => {
		const jobs = parseJobs({ jobs: recorded.jobs[String(run.id)] ?? [] });
		const annotations = new Map(
			jobs.map((job) => [
				job.id,
				parseAnnotations(recorded.annotations[String(job.id)] ?? []),
			]),
		);
		return { run, jobs, annotations };
	});
}

function report(
	recorded: Recorded,
	previous: PreviousReport | undefined = undefined,
): HealthReport {
	return evaluate({
		repository: REPOSITORY,
		data: { runs: pagesOf(recorded) },
		windowStart: "2026-11-12T10:00:00.000Z",
		windowEnd: recorded.now,
		nowMs: Date.parse(recorded.now),
		thresholds: THRESHOLDS,
		previous,
		truncated: false,
		requests: 0,
		dryRun: false,
	});
}

const clearReport = report(clear);
const breachReport = report(breach);

describe("ci-health signals from recorded pages", () => {
	it("H1 is clear when no route step fell back", () => {
		assert.equal(clearReport.signals.H1.state, "clear");
	});
	it("H1 breaches on a hobo-ci-route-fallback warning", () => {
		assert.equal(breachReport.signals.H1.state, "breach");
		assert.match(
			breachReport.signals.H1.evidence[0] ?? "",
			/runs\/201: runner routing did not run/,
		);
	});

	it("H2 is clear when every routing slip read was used", () => {
		assert.equal(clearReport.signals.H2.state, "clear");
		assert.equal(
			clearReport.signals.H2.summary,
			"0 of 4 routing slips unusable",
		);
	});
	it("H2 breaches when every one of at least 5 slip reads could not be used, and leaves an absent slip to H3", () => {
		assert.equal(breachReport.signals.H2.state, "breach");
		assert.equal(
			breachReport.signals.H2.summary,
			"7 of 7 routing slips unusable",
		);
		assert.match(
			breachReport.signals.H2.evidence[0] ?? "",
			/: the routing slip was not read in time$/,
		);
	});
	it("H2 counts more than 5% of at least 20, or all of at least 5", () => {
		assert.equal(h2Breaches(1, 20), false);
		assert.equal(h2Breaches(2, 20), true);
		assert.equal(h2Breaches(4, 4), false);
		assert.equal(h2Breaches(5, 5), true);
		assert.equal(h2Breaches(1, 19), false);
	});

	it("H3 is clear when every route job found a current slip", () => {
		assert.equal(clearReport.signals.H3.state, "clear");
	});
	it("H3 breaches on a route notice that found no routing slip", () => {
		assert.equal(breachReport.signals.H3.state, "breach");
		assert.deepEqual(breachReport.signals.H3.evidence, [
			"https://github.com/Hobo-Labs/HoBo/actions/runs/202",
		]);
	});

	it("counts every fallback to the queue rule by the reason the route job gave (plan 0026, 4)", () => {
		assert.deepEqual(clearReport.slipFallbacks, { total: 0, byReason: {} });
		assert.equal(breachReport.slipFallbacks.total, 8);
		assert.equal(breachReport.slipFallbacks.byReason["no routing slip"], 1);
		assert.equal(
			Object.values(breachReport.slipFallbacks.byReason).reduce(
				(sum, count) => sum + count,
				0,
			),
			8,
		);
		assert.match(breachReport.signals.H3.summary, /\(no routing slip 1\)$/);
		assert.match(
			renderReport(breachReport),
			/Route fallbacks to the queue rule: 8 \(.*no routing slip 1.*\)\./,
		);
		assert.match(
			renderReport(clearReport),
			/Route fallbacks to the queue rule: none\./,
		);
	});

	it("H6 is clear when fleet jobs waited under the limit, and the main gate's concurrency wait does not count", () => {
		assert.equal(clearReport.signals.H6.state, "clear");
	});
	it("H6 breaches on a shard that waited 36 minutes and a job still queued past the limit (ARC down or over-declared; a block between route and plan)", () => {
		assert.equal(breachReport.signals.H6.state, "breach");
		assert.equal(breachReport.signals.H6.evidence.length, 2);
		assert.match(
			breachReport.signals.H6.evidence[0] ?? "",
			/shard 5 waited 36 min/,
		);
		assert.match(
			breachReport.signals.H6.evidence[1] ?? "",
			/\(finish\) waited 45 min/,
		);
	});

	it("H8 is clear under the paid-minutes limit, leaving out the route job and the gates", () => {
		assert.equal(clearReport.signals.H8.state, "clear");
		assert.equal(clearReport.paidMinutes.total, 38);
		// The relay's slip sent that run to GitHub-hosted.
		assert.equal(clearReport.paidMinutes.byRefusal.slip, 38);
	});
	it("H8 breaches over the limit, split by what refused the fleet", () => {
		assert.equal(breachReport.signals.H8.state, "breach");
		assert.equal(breachReport.paidMinutes.total, 159);
		assert.equal(breachReport.paidMinutes.byRefusal.queue, 159);
	});

	it("computes no reporter or allowance signal: the status route they read is retired (plan 0026, 3.9)", () => {
		assert.deepEqual(Object.keys(clearReport.signals), [
			"H1",
			"H2",
			"H3",
			"H6",
			"H8",
		]);
		assert.equal("statusRoute" in clearReport, false);
		assert.equal("statusWhy" in clearReport, false);
		// A report written before the retirement still gives its window end.
		assert.deepEqual(
			parsePreviousReport(
				parseJson(
					'{"windowEnd":"2026-11-12T10:00:00.000Z","statusRoute":"unknown"}',
				),
				Date.parse(clear.now),
			),
			{ windowEnd: "2026-11-12T10:00:00.000Z" },
		);
	});

	it("the clear window breaches nothing; the breach window breaches every signal", () => {
		assert.equal(clearReport.outcome, "clear");
		assert.equal(breachReport.outcome, "breach");
		for (const [signal, result] of Object.entries(breachReport.signals))
			assert.equal(result.state, "breach", signal);
	});
});

describe("ci-health readers", () => {
	it("reads a route notice and ignores anything else", () => {
		assert.deepEqual(
			parseRouteNotice(
				'{"v":2,"workflow":"hobo-ci.yml","tier":"fleet","runner":"hobo","slip":"fallback","why":"no routing slip","refusedBy":"none"}',
			),
			{ slip: "fallback", why: "no routing slip", refusedBy: "none" },
		);
		assert.equal(parseRouteNotice("not json"), undefined);
		// The hosted relay's verdict notice (v1) is no longer read.
		assert.equal(
			parseRouteNotice(
				'{"v":1,"workflow":"hobo-ci.yml","tier":"fleet","runner":"hobo","relay":"verdict","why":"","refusedBy":"none"}',
			),
			undefined,
		);
		assert.equal(parseRouteNotice('{"v":2,"relay":"verdict"}'), undefined);
	});
	it("holds the route script's slip fallback and absent-slip reasons", () => {
		assert.equal(SLIP_FALLBACK_PREFIX, ROUTE_SLIP_FALLBACK_PREFIX);
		assert.deepEqual([...ABSENT_SLIP_WHYS], [...ROUTE_ABSENT_SLIP_WHYS]);
	});
	it("counts a route that did not run under H1, and a slip fallback not", () => {
		const fallback = (message: string) => ({
			path: ".github",
			start_line: 1,
			end_line: 1,
			annotation_level: "warning",
			title: "hobo-ci-route-fallback",
			message,
			raw_details: "",
		});
		const [run] = parseRuns({ workflow_runs: [breach.runs[0] ?? null] });
		assert.ok(run);
		const jobs = parseJobs({ jobs: breach.jobs[String(run.id)] ?? [] });
		const routeJob = jobs.find((job) => job.name === "Route runners");
		assert.ok(routeJob);
		const evidence = routeEvidence({
			run,
			jobs,
			annotations: new Map([
				[
					routeJob.id,
					parseAnnotations([
						fallback(
							"routing slip not used (no routing slip); the queue rule decides",
						),
						fallback(
							"runner routing did not run (the routing script failed); using GitHub-hosted runners",
						),
					]),
				],
			]),
		});
		assert.deepEqual(evidence.fallbacks, [
			"runner routing did not run (the routing script failed); using GitHub-hosted runners",
		]);
	});
	it("reads the report from an uploaded artifact's zip", () => {
		const body = { windowEnd: "2026-11-12T10:00:00.000Z" };
		assert.deepEqual(
			readJsonFromZip(zipOf("ci-health-report.json", JSON.stringify(body))),
			body,
		);
		assert.equal(readJsonFromZip(Buffer.from("not a zip")), undefined);
	});
	it("ignores a previous window that ends in the future", () => {
		const now = Date.parse("2026-11-12T12:00:00Z");
		assert.equal(
			parsePreviousReport(
				parseJson('{"windowEnd":"2026-11-12T13:00:00Z"}'),
				now,
			),
			undefined,
		);
		assert.equal(
			parsePreviousReport(
				parseJson('{"windowEnd":"2026-11-12T11:00:00Z"}'),
				now,
			)?.windowEnd,
			"2026-11-12T11:00:00.000Z",
		);
	});
});

/** A one-file zip archive, deflated, as upload-artifact writes it. */
function zipOf(name: string, text: string): Buffer {
	const data = Buffer.from(text);
	const packed = deflateRawSync(data);
	const nameBytes = Buffer.from(name);
	const local = Buffer.alloc(30);
	local.writeUInt32LE(0x04034b50, 0);
	local.writeUInt16LE(20, 4);
	local.writeUInt16LE(8, 8);
	local.writeUInt32LE(packed.length, 18);
	local.writeUInt32LE(data.length, 22);
	local.writeUInt16LE(nameBytes.length, 26);
	const central = Buffer.alloc(46);
	central.writeUInt32LE(0x02014b50, 0);
	central.writeUInt16LE(20, 6);
	central.writeUInt16LE(8, 10);
	central.writeUInt32LE(packed.length, 20);
	central.writeUInt32LE(data.length, 24);
	central.writeUInt16LE(nameBytes.length, 28);
	central.writeUInt32LE(0, 42);
	const centralAt = local.length + nameBytes.length + packed.length;
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(1, 8);
	end.writeUInt16LE(1, 10);
	end.writeUInt32LE(central.length + nameBytes.length, 12);
	end.writeUInt32LE(centralAt, 16);
	return Buffer.concat([local, nameBytes, packed, central, nameBytes, end]);
}

type Call = Readonly<{ method: string; url: string; body: string }>;

type ApiOptions = Readonly<{
	previous?: Buffer;
	rateLimitAt?: RegExp;
	openIssues?: readonly JsonValue[];
	refuseAssignees?: boolean;
}>;

function json(value: JsonValue, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** GitHub, answering from a recorded window. */
function fakeApi(
	recorded: Recorded,
	options: ApiOptions,
	calls: Call[],
): typeof fetch {
	const answer = (url: string, method: string, body: string): Response => {
		if (options.rateLimitAt?.test(url))
			return new Response("{}", {
				status: 403,
				headers: { "x-ratelimit-remaining": "0" },
			});
		const path = url.replace("https://api.github.com", "");
		if (path.includes("/actions/artifacts?"))
			return json({
				artifacts: options.previous
					? [
							{
								expired: false,
								archive_download_url:
									"https://api.github.com/repos/Hobo-Labs/HoBo/actions/artifacts/9/zip",
							},
						]
					: [],
			});
		if (path.endsWith("/artifacts/9/zip"))
			return new Response(
				options.previous ? new Uint8Array(options.previous) : null,
			);
		if (path.includes("/actions/runs?"))
			return json({
				total_count: recorded.runs.length,
				workflow_runs: recorded.runs.slice(0, 100),
			});
		const jobs = /\/actions\/runs\/(\d+)\/jobs/.exec(path)?.[1];
		if (jobs) return json({ jobs: recorded.jobs[jobs] ?? [] });
		const notes = /\/check-runs\/(\d+)\/annotations/.exec(path)?.[1];
		if (notes) return json(recorded.annotations[notes] ?? []);
		if (method === "GET" && path.includes("/issues?"))
			return json(options.openIssues ?? []);
		if (method === "POST" && /\/issues\/\d+\/comments$/.test(path))
			return json({ id: 1 }, 201);
		if (method === "POST" && path.endsWith("/issues"))
			return options.refuseAssignees && body.includes('"assignees"')
				? json({ message: "Validation Failed" }, 422)
				: json({ number: 77 }, 201);
		return json({ message: "Not Found" }, 404);
	};
	return async (input, init) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = String(init?.body ?? "");
		calls.push({ method, url, body });
		return answer(url, method, body);
	};
}

type Outcome = Readonly<{
	code: number;
	calls: readonly Call[];
	report: HealthReport;
	log: string;
}>;

async function runMain(
	recorded: Recorded,
	options: ApiOptions = {},
	argv: readonly string[] = [],
	env: Readonly<Record<string, string>> = {},
): Promise<Outcome> {
	const dir = mkdtempSync(join(tmpdir(), "ci-health-"));
	const calls: Call[] = [];
	const lines: string[] = [];
	const reportPath = join(dir, "report.json");
	try {
		const code = await main(
			argv,
			{
				GITHUB_REPOSITORY: REPOSITORY,
				GITHUB_TOKEN: "test-token",
				CI_HEALTH_REPORT_PATH: reportPath,
				...env,
			},
			{
				fetch: fakeApi(recorded, options, calls),
				now: () => Date.parse(recorded.now),
				log: (line) => lines.push(line),
			},
		);
		return {
			code,
			calls,
			// SAFETY: main writes the HealthReport it built, as JSON.
			report: JSON.parse(readFileSync(reportPath, "utf8")) as HealthReport,
			log: lines.join("\n"),
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** An issue as the monitor sends it to GitHub. */
type SentIssue = Readonly<{
	title: string;
	labels: readonly string[];
	assignees?: readonly string[];
}>;

function issuesOpened(calls: readonly Call[]): SentIssue[] {
	return calls
		.filter((call) => call.method === "POST" && call.url.endsWith("/issues"))
		.map(
			// SAFETY: raiseIssues sends a SentIssue as the JSON body.
			(call) => JSON.parse(call.body) as SentIssue,
		);
}

/** A window of `count` main-gate runs, each with a route job and a plan job: the most this monitor reads. */
function largestWindow(count: number): Recorded {
	const [run] = clear.runs;
	const [route, plan] = clear.jobs["101"] ?? [];
	assert.ok(run && route && plan);
	const runs: JsonValue[] = [];
	const jobs: Record<string, readonly JsonValue[]> = {};
	const annotations: Record<string, readonly JsonValue[]> = {};
	for (let index = 0; index < count; index += 1) {
		const id = 5000 + index;
		runs.push({ ...Object(run), id });
		jobs[String(id)] = [
			{ ...Object(route), id: id * 10 + 1 },
			{ ...Object(plan), id: id * 10 + 2 },
		];
		annotations[String(id * 10 + 1)] = clear.annotations["1011"] ?? [];
		annotations[String(id * 10 + 2)] = clear.annotations["1012"] ?? [];
	}
	return { ...clear, runs, jobs, annotations };
}

const zipped = (body: string): Buffer => zipOf("ci-health-report.json", body);

describe("ci-health run", () => {
	it("a clear window exits 0, opens nothing and uploads a report whose window ends now", async () => {
		const result = await runMain(clear);
		assert.equal(result.code, 0);
		assert.equal(result.report.outcome, "clear");
		assert.equal(result.report.windowEnd, "2026-11-12T12:00:00.000Z");
		assert.equal(result.report.windowStart, "2026-11-12T10:00:00.000Z");
		// It asks GitHub only: no relay route, no OIDC token.
		for (const call of result.calls)
			assert.match(call.url, /^https:\/\/api\.github\.com\//);
		assert.equal(
			result.calls.filter((call) => call.method === "POST").length,
			0,
		);
	});

	it("starts where the newest uploaded report's window ended", async () => {
		const result = await runMain(clear, {
			previous: zipped('{"windowEnd":"2026-11-12T10:30:00.000Z"}'),
		});
		assert.equal(result.report.windowStart, "2026-11-12T10:30:00.000Z");
		const runsCall = result.calls.find((call) =>
			call.url.includes("/actions/runs?"),
		);
		assert.match(
			decodeURIComponent(runsCall?.url ?? ""),
			/created=2026-11-12T10:30:00\.000Z\.\.2026-11-12T12:00:00\.000Z/,
		);
	});

	it("a breach opens one issue per signal, labelled and assigned, and comments on an open one", async () => {
		const result = await runMain(
			breach,
			{
				openIssues: [
					{
						number: 12,
						title: "[ci-health] H6: 1 fleet job waited more than 30 min",
					},
				],
			},
			[],
			{ CI_HEALTH_ASSIGNEE: "owner-login" },
		);
		assert.equal(result.code, 1);
		const comments = result.calls.filter(
			(call) =>
				call.method === "POST" && call.url.endsWith("/issues/12/comments"),
		);
		assert.equal(comments.length, 1);
		const opened = issuesOpened(result.calls);
		assert.deepEqual(
			opened.map((issue) => issue.title.split(":")[0]),
			["[ci-health] H1", "[ci-health] H2", "[ci-health] H3", "[ci-health] H8"],
		);
		for (const issue of opened) {
			assert.deepEqual(issue.labels, ["ci-health"]);
			assert.deepEqual(issue.assignees, ["owner-login"]);
		}
		assert.equal(
			result.calls.some((call) => call.method === "PATCH"),
			false,
		);
	});

	it("opens the issue unassigned when GitHub refuses the assignee", async () => {
		const result = await runMain(breach, { refuseAssignees: true }, [], {
			CI_HEALTH_ASSIGNEE: "an-organization",
		});
		assert.equal(result.code, 1);
		assert.match(result.log, /H1: opened #77/);
	});

	it("--dry-run prints the report and writes nothing to issues", async () => {
		const result = await runMain(breach, {}, ["--dry-run"]);
		assert.equal(result.code, 0);
		assert.equal(result.report.dryRun, true);
		assert.equal(result.report.outcome, "breach");
		assert.equal(
			result.calls.some((call) => call.method !== "GET"),
			false,
		);
		assert.equal(
			result.calls.some((call) => call.url.includes("/issues")),
			false,
		);
		assert.match(result.log, /\| H1 routing did not run \| breach \|/);
	});

	it("a rate-limit answer fails the run without opening an issue, and the window does not move", async () => {
		const result = await runMain(breach, {
			previous: zipped('{"windowEnd":"2026-11-12T10:30:00.000Z"}'),
			rateLimitAt: /\/jobs/,
		});
		assert.equal(result.code, 2);
		assert.equal(result.report.outcome, "failed");
		assert.match(result.report.failure, /rate limit/);
		assert.equal(result.report.windowEnd, "2026-11-12T10:30:00.000Z");
		assert.equal(
			result.calls.some((call) => call.method === "POST"),
			false,
		);
	});

	it(`B7: the largest window takes at most ${REQUEST_BUDGET} requests, issues included`, async () => {
		// The most issues can add on top: the issue list and one create per
		// signal, twice when an assignee is refused (1 + 5 x 2), 314 in all.
		const result = await runMain(largestWindow(100), {
			previous: zipped('{"windowEnd":"2026-11-12T10:00:00.000Z"}'),
		});
		const total = result.calls.length;
		assert.ok(total + 11 <= REQUEST_BUDGET, `${total} requests`);
		assert.equal(result.report.runs, 100);
		// 2 artifact + 1 run list + 100 jobs + 200 annotations.
		assert.equal(result.report.requests, 303);
		assert.equal(total, 303);
	});

	it("reports truncated when more than 100 runs fall in the window", async () => {
		const result = await runMain(largestWindow(101));
		assert.equal(result.report.truncated, true);
		assert.equal(result.report.runs, 100);
	});
});

describe("ci-health workflow", () => {
	const root = join(import.meta.dirname, "..", "..");
	const read = (path: string): string => readFileSync(join(root, path), "utf8");

	it("the monitor imports nothing but node builtins", () => {
		const imports = [
			...read("scripts/ci/ci-health.mts").matchAll(
				/^import .* from "([^"]+)";$/gm,
			),
		].map((match) => match[1] ?? "");
		assert.ok(imports.length > 0);
		for (const specifier of imports)
			assert.match(specifier, /^node:/, specifier);
	});

	it("runs every two hours and on dispatch, checks out only the monitor and uploads every report", () => {
		const workflow = read(".github/workflows/ci-health.yml");
		assert.match(workflow, /cron: "\d+ \*\/2 \* \* \*"/);
		assert.match(workflow, /workflow_dispatch:\n {4}inputs:\n {6}dry-run:/);
		for (const permission of ["actions: read", "checks: read", "issues: write"])
			assert.match(workflow, new RegExp(`^  ${permission}$`, "m"));
		// No OIDC token: no relay is asked (plan 0026, 3.9).
		assert.doesNotMatch(workflow, /id-token/);
		assert.match(
			workflow,
			/sparse-checkout: \|\n {12}scripts\/ci\/ci-health\.mts\n {6}- /,
		);
		assert.match(workflow, /run: node scripts\/ci\/ci-health\.mts$/m);
		assert.match(
			workflow,
			/if: always\(\)\n {8}uses: actions\/upload-artifact@[0-9a-f]{40}\n {8}with:\n {10}name: \$\{\{ inputs\.dry-run && 'ci-health-dry-run' \|\| 'ci-health-report' \}\}\n {10}path: ci-health-report\.json/,
		);
		for (const setting of [
			"CI_HEALTH_ASSIGNEE",
			"CI_HEALTH_PAID_MINUTES_PER_WINDOW",
			"CI_HEALTH_STALL_MINUTES",
		])
			assert.match(workflow, new RegExp(`^  ${setting}: `, "m"));
	});
});
