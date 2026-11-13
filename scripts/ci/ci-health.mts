#!/usr/bin/env node
/**
 * The CI health monitor: reads what the last window of workflow runs left
 * behind and raises every fallback that would otherwise stay silent
 * (ADR-0180; `docs/ci/health-monitor.md`).
 *
 * Runs every two hours on a GitHub-hosted machine (`ci-health.yml`). It reads
 * the run list, each run's jobs, and the annotations of the route job and of
 * the main gate's plan job, where the route step prints one `hobo-ci-route`
 * notice per decision and a `hobo-ci-route-fallback` warning when it could not
 * decide. It asks the hosted relay's status route which reporters are alive
 * and how much of each label's block allowance is spent. From those it
 * computes seven signals (H1, H2, H3, H4, H6, H8, H10), opens or comments on
 * one issue per breached signal, writes the report to the step summary and to
 * a file the workflow uploads as `ci-health-report`, and exits non-zero on any
 * breach. The next run starts where the newest uploaded report's window ended.
 *
 * It decides nothing about the fleet (R1): it only counts what the route job
 * and the relay already said. It loads no package, only node builtins, so it
 * runs straight from a checkout with `node scripts/ci/ci-health.mts`.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { inflateRawSync } from "node:zlib";

/** The signals, in the order the report lists them. */
export const SIGNALS = ["H1", "H2", "H3", "H4", "H6", "H8", "H10"] as const;
export type Signal = (typeof SIGNALS)[number];

export const SIGNAL_NAMES = {
	H1: "routing did not run",
	H2: "relay asked, no verdict",
	H3: "relay not asked",
	H4: "reporter silent",
	H6: "stall",
	H8: "paid minutes",
	H10: "allowance spent",
} as const satisfies Readonly<Record<Signal, string>>;

/** Runs read per window; past this the report says `truncated`. */
export const MAX_RUNS = 100;
/** Every request a run may make, GitHub's and the relay's together. */
export const REQUEST_BUDGET = 350;
/** The window when no earlier report exists. */
export const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000;
export const DEFAULT_STALL_MINUTES = 30;
export const DEFAULT_PAID_MINUTES_PER_WINDOW = 150;
/** A reporter in `shadow` or `report` that has not reported for this long is silent. */
export const REPORTER_SILENT_MS = 10 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 15_000;

export const ARTIFACT_NAME = "ci-health-report";
export const REPORT_FILE = "ci-health-report.json";
export const ISSUE_LABEL = "ci-health";

/** The route job of every routed workflow, and the main gate's plan job that asks again. */
export const ROUTE_JOB = "Route runners";
export const PLAN_JOB = "Main workspace plan";
/** Waits on its concurrency group, not on a runner. */
export const STALL_EXCLUDED_JOBS: ReadonlySet<string> = new Set([
	"Main full gate",
]);
/** Hosted whatever the fleet does: the route job, the gates, this monitor. */
export const PAID_EXCLUDED_JOBS: ReadonlySet<string> = new Set([
	ROUTE_JOB,
	"PR impact gate",
	"HoBo release PR gate (required)",
	"CI health",
]);
export const FLEET_LABELS: ReadonlySet<string> = new Set([
	"hobo",
	"hobo-trunk",
]);
export const HOSTED_LABEL = "ubuntu-24.04";

export const NOTICE_TITLE = "hobo-ci-route";
export const FALLBACK_TITLE = "hobo-ci-route-fallback";

// --- JSON, read at the boundary ---

/** A parsed JSON document: what GitHub and the relay answer with. */
export type JsonValue =
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;
interface JsonObject {
	readonly [key: string]: JsonValue;
}

const tagOf = Object.prototype.toString;

function asObject(value: JsonValue | undefined): JsonObject | undefined {
	// SAFETY: the tag check proves a plain object, which JSON.parse only produces as a JsonObject.
	return tagOf.call(value) === "[object Object]"
		? (value as JsonObject)
		: undefined;
}
function asText(value: JsonValue | undefined): string | undefined {
	// SAFETY: the tag check proves a string primitive.
	return tagOf.call(value) === "[object String]"
		? (value as string)
		: undefined;
}
function asNumber(value: JsonValue | undefined): number | undefined {
	// SAFETY: the tag check proves a number primitive.
	return tagOf.call(value) === "[object Number]"
		? (value as number)
		: undefined;
}
function asList(value: JsonValue | undefined): readonly JsonValue[] {
	return Array.isArray(value) ? value : [];
}

/** `JSON.parse`, or nothing when the text is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
	try {
		// SAFETY: a JSON document is a JsonValue by construction.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

// --- What the GitHub REST API and the relay answer (only the fields read) ---

export type WorkflowRun = Readonly<{
	id: number;
	htmlUrl: string;
	createdAt: string;
}>;

export type WorkflowJob = Readonly<{
	id: number;
	name: string;
	status: string;
	conclusion: string;
	labels: readonly string[];
	/** Empty until a runner takes the job. */
	runnerName: string;
	htmlUrl: string;
	createdAt: string;
	startedAt: string;
	completedAt: string;
}>;

export type Annotation = Readonly<{
	level: string;
	title: string;
	message: string;
}>;

export type ReporterStatus = Readonly<{
	id: string;
	mode: string;
	lastReportAt: string;
}>;

export type LabelAllowance = Readonly<{
	label: string;
	usedSeconds: number;
	spent: boolean;
}>;

/** `FleetReporterStatusList` in `packages/ci-gh-actions/data-models/fleet_verdict.proto`, the fields read. */
export type ReporterStatusList = Readonly<{
	reporters: readonly ReporterStatus[];
	allowance: readonly LabelAllowance[];
	dailyBlockMinutes: number;
}>;

/** The relay's status, or why it could not be read. */
export type StatusReading =
	| Readonly<{ kind: "known"; list: ReporterStatusList }>
	| Readonly<{ kind: "unknown"; why: string }>;

/** One run of the window: the run, its jobs, and the route annotations by job id. */
export type RunPages = Readonly<{
	run: WorkflowRun;
	jobs: readonly WorkflowJob[];
	annotations: ReadonlyMap<number, readonly Annotation[]>;
}>;

/** Everything one window's runs left behind. */
export type WindowData = Readonly<{
	runs: readonly RunPages[];
	status: StatusReading;
}>;

/** The runs of a `GET /repos/{r}/actions/runs` page. */
export function parseRuns(page: JsonValue | undefined): WorkflowRun[] {
	return asList(asObject(page)?.workflow_runs).flatMap((entry) => {
		const run = asObject(entry);
		const id = asNumber(run?.id);
		if (id === undefined) return [];
		return [
			{
				id,
				htmlUrl: asText(run?.html_url) ?? `run ${id}`,
				createdAt: asText(run?.created_at) ?? "",
			},
		];
	});
}

/** The jobs of a `GET /repos/{r}/actions/runs/{id}/jobs` page. */
export function parseJobs(page: JsonValue | undefined): WorkflowJob[] {
	return asList(asObject(page)?.jobs).flatMap((entry) => {
		const job = asObject(entry);
		const id = asNumber(job?.id);
		if (id === undefined) return [];
		return [
			{
				id,
				name: asText(job?.name) ?? "",
				status: asText(job?.status) ?? "",
				conclusion: asText(job?.conclusion) ?? "",
				labels: asList(job?.labels).flatMap((label) => asText(label) ?? []),
				runnerName: asText(job?.runner_name) ?? "",
				htmlUrl: asText(job?.html_url) ?? "",
				createdAt: asText(job?.created_at) ?? "",
				startedAt: asText(job?.started_at) ?? "",
				completedAt: asText(job?.completed_at) ?? "",
			},
		];
	});
}

/** A `GET /repos/{r}/check-runs/{id}/annotations` answer. */
export function parseAnnotations(page: JsonValue | undefined): Annotation[] {
	return asList(page).flatMap((entry) => {
		const annotation = asObject(entry);
		const message = asText(annotation?.message);
		if (message === undefined) return [];
		return [
			{
				level: asText(annotation?.annotation_level) ?? "",
				title: asText(annotation?.title) ?? "",
				message,
			},
		];
	});
}

/** A status list for `repository`, or nothing when the answer is not one. */
export function parseStatusList(
	document: JsonValue | undefined,
	repository: string,
): ReporterStatusList | undefined {
	const list = asObject(document);
	const reporters = list?.reporters;
	if (
		asText(list?.repository)?.toLowerCase() !== repository.toLowerCase() ||
		!Array.isArray(reporters)
	)
		return undefined;
	const allowance = asObject(list?.allowance) ?? {};
	return {
		reporters: asList(reporters).flatMap((entry) => {
			const reporter = asObject(entry);
			const id = asText(reporter?.id);
			if (id === undefined) return [];
			const state = asObject(reporter?.state);
			return [
				{
					id,
					mode: asText(state?.mode) ?? "",
					lastReportAt: asText(state?.lastReportAt) ?? "",
				},
			];
		}),
		allowance: Object.entries(allowance).map(([label, value]) => {
			const use = asObject(value);
			return {
				label,
				usedSeconds: asNumber(use?.usedSeconds) ?? 0,
				spent: use?.spent === true,
			};
		}),
		dailyBlockMinutes: asNumber(list?.dailyBlockMinutes) ?? 0,
	};
}

// --- The report ---

export type SignalState = "breach" | "clear" | "unknown";

export type SignalResult = Readonly<{
	state: SignalState;
	summary: string;
	/** Links or short lines, at most ten. */
	evidence: readonly string[];
}>;

export type RouteNotice = Readonly<{
	relay: string;
	why: string;
	refusedBy: string;
}>;

/** What took a run off the fleet, for the paid-minutes split. */
export type Refusal = "relay" | "queue" | "none" | "fallback" | "unrouted";

export type RefusalMinutes = {
	relay: number;
	queue: number;
	none: number;
	fallback: number;
	unrouted: number;
};

export type Signals = Readonly<{
	H1: SignalResult;
	H2: SignalResult;
	H3: SignalResult;
	H4: SignalResult;
	H6: SignalResult;
	H8: SignalResult;
	H10: SignalResult;
}>;

export type HealthReport = Readonly<{
	v: 1;
	repository: string;
	windowStart: string;
	windowEnd: string;
	generatedAt: string;
	dryRun: boolean;
	/** `failed`: the window could not be read; it is read again next time. */
	outcome: "clear" | "breach" | "failed";
	/** Why the run failed; empty otherwise. */
	failure: string;
	truncated: boolean;
	runs: number;
	requests: number;
	/** Whether the relay's status route answered; two `unknown` in a row raise H2. */
	statusRoute: "known" | "unknown";
	/** Why the status route was not read; empty when it was. */
	statusWhy: string;
	signals: Signals;
	paidMinutes: Readonly<{ total: number; byRefusal: RefusalMinutes }>;
}>;

export type Thresholds = Readonly<{
	stallMinutes: number;
	paidMinutesPerWindow: number;
}>;

/** The previous report's fields this run reads: where its window ended and whether the status route answered. */
export type PreviousReport = Readonly<{
	windowEnd: string;
	statusRoute: "known" | "unknown";
}>;

// --- Pure: from parsed pages to a report ---

function ms(iso: string): number | undefined {
	const value = Date.parse(iso);
	return Number.isFinite(value) ? value : undefined;
}

function cap(lines: readonly string[]): string[] {
	return lines.slice(0, 10);
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** A `hobo-ci-route` notice's record, or nothing when it is not one. */
export function parseRouteNotice(message: string): RouteNotice | undefined {
	const record = asObject(parseJson(message));
	const relay = asText(record?.relay);
	if (asNumber(record?.v) !== 1 || !relay) return undefined;
	return {
		relay,
		why: asText(record?.why) ?? "",
		refusedBy: asText(record?.refusedBy) ?? "",
	};
}

/** The jobs whose check runs carry the route step's annotations. */
export function routeCheckRuns(
	jobs: readonly WorkflowJob[],
): readonly WorkflowJob[] {
	return jobs.filter(
		(job) =>
			(job.name === ROUTE_JOB || job.name === PLAN_JOB) &&
			job.status === "completed" &&
			job.conclusion !== "skipped",
	);
}

export type RouteEvidence = Readonly<{
	run: WorkflowRun;
	notices: readonly RouteNotice[];
	fallbacks: readonly string[];
}>;

export function routeEvidence(pages: RunPages): RouteEvidence {
	const notices: RouteNotice[] = [];
	const fallbacks: string[] = [];
	// The route job first, then the plan job's second ask.
	const checks = [...routeCheckRuns(pages.jobs)].sort(
		(a, b) => Number(b.name === ROUTE_JOB) - Number(a.name === ROUTE_JOB),
	);
	for (const job of checks)
		for (const annotation of pages.annotations.get(job.id) ?? []) {
			if (annotation.title === FALLBACK_TITLE)
				fallbacks.push(annotation.message);
			if (annotation.title !== NOTICE_TITLE) continue;
			const notice = parseRouteNotice(annotation.message);
			if (notice) notices.push(notice);
		}
	return { run: pages.run, notices, fallbacks };
}

export function signalH1(evidence: readonly RouteEvidence[]): SignalResult {
	const hits = evidence.filter((entry) => entry.fallbacks.length > 0);
	const count = hits.reduce((sum, entry) => sum + entry.fallbacks.length, 0);
	if (count === 0)
		return { state: "clear", summary: "no routing fallback", evidence: [] };
	return {
		state: "breach",
		summary: `${plural(count, "routing fallback")} in ${plural(hits.length, "run")}`,
		evidence: cap(
			hits.map((entry) => `${entry.run.htmlUrl}: ${entry.fallbacks[0]}`),
		),
	};
}

/** More than 5% of at least 20 asks, or every one of at least 5, went unanswered. */
export function h2Breaches(unanswered: number, asked: number): boolean {
	return (
		(asked >= 20 && unanswered / asked > 0.05) ||
		(asked >= 5 && unanswered === asked)
	);
}

/** `unknownTwice` is why the status route went unread a second run running; empty when it did not. */
export function signalH2(
	evidence: readonly RouteEvidence[],
	unknownTwice: string,
): SignalResult {
	let asked = 0;
	const lines: string[] = [];
	for (const entry of evidence)
		for (const notice of entry.notices) {
			if (notice.relay !== "verdict" && notice.relay !== "unanswered") continue;
			asked += 1;
			if (notice.relay === "unanswered")
				lines.push(`${entry.run.htmlUrl}: ${notice.why}`);
		}
	const ratio = `${lines.length} of ${asked} relay asks unanswered`;
	if (unknownTwice)
		return {
			state: "breach",
			summary: `relay status route unread two runs running (${unknownTwice}); ${ratio}`,
			evidence: cap(lines),
		};
	return {
		state: h2Breaches(lines.length, asked) ? "breach" : "clear",
		summary: ratio,
		evidence: cap(lines),
	};
}

export function signalH3(evidence: readonly RouteEvidence[]): SignalResult {
	const hits = evidence.filter((entry) =>
		entry.notices.some(
			(notice) => notice.relay === "unasked" && notice.why === "no-relay",
		),
	);
	if (hits.length === 0)
		return {
			state: "clear",
			summary: "every route job could ask the relay",
			evidence: [],
		};
	return {
		state: "breach",
		summary: `${plural(hits.length, "run")} routed without a relay to ask`,
		evidence: cap(hits.map((entry) => entry.run.htmlUrl)),
	};
}

export function signalH4(status: StatusReading, nowMs: number): SignalResult {
	if (status.kind === "unknown")
		return {
			state: "unknown",
			summary: `status route: ${status.why}`,
			evidence: [],
		};
	const silent = status.list.reporters.filter((reporter) => {
		if (reporter.mode !== "shadow" && reporter.mode !== "report") return false;
		const last = ms(reporter.lastReportAt);
		return last === undefined || nowMs - last > REPORTER_SILENT_MS;
	});
	if (silent.length === 0)
		return {
			state: "clear",
			summary: `${plural(status.list.reporters.length, "enrolled reporter")}, none silent`,
			evidence: [],
		};
	return {
		state: "breach",
		summary: `${silent.map((reporter) => reporter.id).join(", ")} silent for more than 10 minutes`,
		evidence: cap(
			silent.map(
				(reporter) =>
					`${reporter.id} (${reporter.mode}): last report ${reporter.lastReportAt || "never"}`,
			),
		),
	};
}

/** How long a job waited for a runner, or has been waiting; nothing for a job that never asked. */
export function waitedMs(job: WorkflowJob, nowMs: number): number | undefined {
	if (job.conclusion === "skipped") return undefined;
	const created = ms(job.createdAt);
	if (created === undefined) return undefined;
	let end: number | undefined = nowMs;
	if (job.runnerName) end = ms(job.startedAt);
	else if (job.status === "completed") end = ms(job.completedAt);
	return end === undefined ? undefined : Math.max(0, end - created);
}

export function signalH6(
	runs: readonly RunPages[],
	nowMs: number,
	stallMinutes: number,
): SignalResult {
	const limitMs = stallMinutes * 60_000;
	const stalls: string[] = [];
	for (const pages of runs)
		for (const job of pages.jobs) {
			if (STALL_EXCLUDED_JOBS.has(job.name)) continue;
			if (!job.labels.some((label) => FLEET_LABELS.has(label))) continue;
			const waited = waitedMs(job, nowMs);
			if (waited === undefined || waited <= limitMs) continue;
			stalls.push(
				`${job.htmlUrl || pages.run.htmlUrl}: ${job.name} waited ${Math.round(waited / 60_000)} min for ${job.labels.join(",")}`,
			);
		}
	if (stalls.length === 0)
		return {
			state: "clear",
			summary: `no fleet job waited more than ${stallMinutes} min`,
			evidence: [],
		};
	return {
		state: "breach",
		summary: `${plural(stalls.length, "fleet job")} waited more than ${stallMinutes} min`,
		evidence: cap(stalls),
	};
}

/** What took a run off the fleet: a fallback, else the last route notice, else nothing routed it. */
export function runRefusal(entry: RouteEvidence): Refusal {
	if (entry.fallbacks.length > 0) return "fallback";
	const last = entry.notices.at(-1);
	if (!last) return "unrouted";
	if (last.refusedBy === "relay") return "relay";
	if (last.refusedBy === "queue") return "queue";
	return "none";
}

/** Billed minutes of one GitHub-hosted job: rounded up per job, as GitHub bills. */
export function paidMinutes(job: WorkflowJob): number {
	if (!job.labels.includes(HOSTED_LABEL)) return 0;
	if (PAID_EXCLUDED_JOBS.has(job.name) || !job.runnerName) return 0;
	const started = ms(job.startedAt);
	const completed = ms(job.completedAt);
	if (started === undefined || completed === undefined) return 0;
	return Math.ceil(Math.max(0, completed - started) / 60_000);
}

export type PaidMinutesResult = Readonly<{
	result: SignalResult;
	byRefusal: RefusalMinutes;
	total: number;
}>;

export function signalH8(
	runs: readonly RunPages[],
	limit: number,
): PaidMinutesResult {
	const byRefusal: RefusalMinutes = {
		relay: 0,
		queue: 0,
		none: 0,
		fallback: 0,
		unrouted: 0,
	};
	for (const pages of runs)
		byRefusal[runRefusal(routeEvidence(pages))] += pages.jobs.reduce(
			(sum, job) => sum + paidMinutes(job),
			0,
		);
	const parts = Object.entries(byRefusal).filter(([, minutes]) => minutes > 0);
	const total = parts.reduce((sum, [, minutes]) => sum + minutes, 0);
	const split = parts
		.map(([refusal, minutes]) => `${refusal} ${minutes}`)
		.join(", ");
	return {
		result: {
			state: total > limit ? "breach" : "clear",
			summary: `${plural(total, "paid minute")} (limit ${limit})${split ? `: ${split}` : ""}`,
			evidence: [],
		},
		byRefusal,
		total,
	};
}

export function signalH10(status: StatusReading): SignalResult {
	if (status.kind === "unknown")
		return {
			state: "unknown",
			summary: `status route: ${status.why}`,
			evidence: [],
		};
	const spent = status.list.allowance.filter((use) => use.spent);
	if (spent.length === 0)
		return {
			state: "clear",
			summary: "no label's allowance is spent",
			evidence: [],
		};
	return {
		state: "breach",
		summary: `block allowance spent for ${spent.map((use) => use.label).join(", ")}`,
		evidence: cap(
			spent.map(
				(use) =>
					`${use.label}: ${Math.round(use.usedSeconds / 60)} of ${status.list.dailyBlockMinutes} min`,
			),
		),
	};
}

export type EvaluateInput = Readonly<{
	repository: string;
	data: WindowData;
	windowStart: string;
	windowEnd: string;
	nowMs: number;
	thresholds: Thresholds;
	previous: PreviousReport | undefined;
	truncated: boolean;
	requests: number;
	dryRun: boolean;
}>;

export function evaluate(input: EvaluateInput): HealthReport {
	const evidence = input.data.runs.map(routeEvidence);
	const status = input.data.status;
	const statusWhy = status.kind === "unknown" ? status.why : "";
	const unknownTwice =
		input.previous?.statusRoute === "unknown" ? statusWhy : "";
	const h8 = signalH8(input.data.runs, input.thresholds.paidMinutesPerWindow);
	const signals: Signals = {
		H1: signalH1(evidence),
		H2: signalH2(evidence, unknownTwice),
		H3: signalH3(evidence),
		H4: signalH4(status, input.nowMs),
		H6: signalH6(input.data.runs, input.nowMs, input.thresholds.stallMinutes),
		H8: h8.result,
		H10: signalH10(status),
	};
	const breach = SIGNALS.some((signal) => signals[signal].state === "breach");
	return {
		v: 1,
		repository: input.repository,
		windowStart: input.windowStart,
		windowEnd: input.windowEnd,
		generatedAt: new Date(input.nowMs).toISOString(),
		dryRun: input.dryRun,
		outcome: breach ? "breach" : "clear",
		failure: "",
		truncated: input.truncated,
		runs: input.data.runs.length,
		requests: input.requests,
		statusRoute: status.kind,
		statusWhy,
		signals,
		paidMinutes: { total: h8.total, byRefusal: h8.byRefusal },
	};
}

/** The report as Markdown, for the step summary and the console. */
export function renderReport(report: HealthReport): string {
	const lines = [
		`## CI health: ${report.outcome}${report.dryRun ? " (dry run)" : ""}`,
		"",
		`Window ${report.windowStart} to ${report.windowEnd}: ${plural(report.runs, "run")}${report.truncated ? `, truncated at ${MAX_RUNS}` : ""}, ${plural(report.requests, "request")}.`,
	];
	if (report.failure) lines.push("", `Failed: ${report.failure}`);
	lines.push("", "| Signal | State | Summary |", "| --- | --- | --- |");
	for (const signal of SIGNALS) {
		const result = report.signals[signal];
		lines.push(
			`| ${signal} ${SIGNAL_NAMES[signal]} | ${result.state} | ${result.summary.replaceAll("|", "\\|")} |`,
		);
	}
	for (const signal of SIGNALS) {
		const result = report.signals[signal];
		if (result.evidence.length === 0) continue;
		lines.push(
			"",
			`### ${signal}`,
			"",
			...result.evidence.map((line) => `- ${line}`),
		);
	}
	return `${lines.join("\n")}\n`;
}

/** Open issues are matched on everything up to the colon. */
export function issuePrefix(signal: Signal): string {
	return `[ci-health] ${signal}:`;
}

export function issueTitle(signal: Signal, result: SignalResult): string {
	return `${issuePrefix(signal)} ${result.summary}`.slice(0, 250);
}

export function issueBody(
	signal: Signal,
	report: HealthReport,
	runUrl: string,
): string {
	const result = report.signals[signal];
	return [
		`**${signal} ${SIGNAL_NAMES[signal]}**: ${result.summary}`,
		"",
		`Window ${report.windowStart} to ${report.windowEnd} (${plural(report.runs, "run")}).${runUrl ? ` Monitor run: ${runUrl}` : ""}`,
		...(result.evidence.length > 0
			? ["", ...result.evidence.map((line) => `- ${line}`)]
			: []),
		"",
		"See docs/ci/health-monitor.md for what this signal means and what to do.",
	].join("\n");
}

/** The relay's origin from `.hobo/ci.json`: the default environment's `relayOrigin`, `https` only. */
export function parseRelayOrigin(text: string): string | undefined {
	const project = asObject(parseJson(text));
	const environment = asObject(
		asObject(project?.environments)?.[
			asText(project?.defaultEnvironment) ?? ""
		],
	);
	let url: URL;
	try {
		url = new URL(asText(environment?.relayOrigin) ?? "");
	} catch {
		return undefined;
	}
	if (url.protocol !== "https:" || url.username || url.password)
		return undefined;
	return url.origin;
}

// --- The previous report, from the newest uploaded artifact ---

/** The first `.json` file in a zip archive, found through its central directory. */
export function readJsonFromZip(zip: Buffer): JsonValue | undefined {
	const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocd < 0) return undefined;
	const entries = zip.readUInt16LE(eocd + 10);
	let at = zip.readUInt32LE(eocd + 16);
	for (let index = 0; index < entries; index += 1) {
		if (zip.readUInt32LE(at) !== 0x02014b50) return undefined;
		const method = zip.readUInt16LE(at + 10);
		const compressed = zip.readUInt32LE(at + 20);
		const nameLength = zip.readUInt16LE(at + 28);
		const local = zip.readUInt32LE(at + 42);
		const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
		at +=
			46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
		if (!name.endsWith(".json")) continue;
		const start =
			local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
		const bytes = zip.subarray(start, start + compressed);
		if (method === 0) return parseJson(bytes.toString("utf8"));
		if (method === 8) return parseJson(inflateRawSync(bytes).toString("utf8"));
		return undefined;
	}
	return undefined;
}

export function parsePreviousReport(
	document: JsonValue | undefined,
	nowMs: number,
): PreviousReport | undefined {
	const report = asObject(document);
	const end = ms(asText(report?.windowEnd) ?? "");
	if (end === undefined || end > nowMs) return undefined;
	return {
		windowEnd: new Date(end).toISOString(),
		statusRoute:
			asText(report?.statusRoute) === "unknown" ? "unknown" : "known",
	};
}

// --- Fetching, within the budget ---

export class RateLimited extends Error {}
export class BudgetSpent extends Error {}

export type GithubRequest = Readonly<{ method: "GET" | "POST"; body: string }>;

export type Http = Readonly<{
	/** GitHub's REST API: a path below the API root; JSON out. */
	github(path: string, request?: GithubRequest): Promise<JsonValue | undefined>;
	/** A whole URL, raw; for the artifact archive, the OIDC token and the relay. */
	raw(url: string, headers: HeadersInit): Promise<Response>;
	requests(): number;
	/** The GitHub token, for the archive download; empty when there is none. */
	token: string;
}>;

export type HttpOptions = Readonly<{
	token: string;
	apiUrl: string;
	fetch: typeof fetch;
}>;

export function createHttp(options: HttpOptions): Http {
	let count = 0;
	const send = (url: string, init: RequestInit): Promise<Response> => {
		if (count >= REQUEST_BUDGET)
			throw new BudgetSpent(`request budget of ${REQUEST_BUDGET} spent`);
		count += 1;
		return options.fetch(url, {
			...init,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	};
	return {
		token: options.token,
		requests: () => count,
		raw: (url, headers) => send(url, { method: "GET", headers }),
		async github(path, request) {
			const headers = new Headers({
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"User-Agent": "hobo-ci-health",
			});
			if (options.token)
				headers.set("Authorization", `Bearer ${options.token}`);
			const init: RequestInit = { method: "GET", headers };
			if (request) {
				headers.set("Content-Type", "application/json");
				init.method = request.method;
				init.body = request.body;
			}
			const response = await send(`${options.apiUrl}${path}`, init);
			const text = await response.text().catch(() => "");
			if (
				response.status === 429 ||
				(response.status === 403 &&
					(response.headers.get("x-ratelimit-remaining") === "0" ||
						/rate limit/i.test(text)))
			)
				throw new RateLimited(`GitHub rate limit at ${path}`);
			if (!response.ok)
				throw new Error(`GitHub answered ${response.status} at ${path}`);
			return parseJson(text);
		},
	};
}

/** The newest uploaded report, or nothing when there is none or it cannot be read. */
export async function readPreviousReport(
	http: Http,
	repository: string,
	nowMs: number,
	log: (line: string) => void,
): Promise<PreviousReport | undefined> {
	const page = await http.github(
		`/repos/${repository}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=1`,
	);
	const artifact = asList(asObject(page)?.artifacts)
		.map(asObject)
		.find((entry) => entry !== undefined && entry.expired !== true);
	const url = asText(artifact?.archive_download_url);
	if (!url) return undefined;
	const headers = new Headers({
		Accept: "application/vnd.github+json",
		"User-Agent": "hobo-ci-health",
	});
	if (http.token) headers.set("Authorization", `Bearer ${http.token}`);
	try {
		const response = await http.raw(url, headers);
		if (!response.ok) throw new Error(`archive answered ${response.status}`);
		const previous = parsePreviousReport(
			readJsonFromZip(Buffer.from(await response.arrayBuffer())),
			nowMs,
		);
		if (!previous) log("previous report unreadable; using the last two hours");
		return previous;
	} catch (error) {
		if (error instanceof BudgetSpent) throw error;
		log(
			`previous report unreadable (${error instanceof Error ? error.message : String(error)}); using the last two hours`,
		);
		return undefined;
	}
}

/** Reads the window's runs, their jobs, and the route annotations. */
export async function readWindow(
	http: Http,
	repository: string,
	windowStart: string,
	windowEnd: string,
): Promise<Readonly<{ runs: RunPages[]; truncated: boolean }>> {
	const page = await http.github(
		`/repos/${repository}/actions/runs?per_page=${MAX_RUNS}&created=${encodeURIComponent(`${windowStart}..${windowEnd}`)}`,
	);
	const listed = parseRuns(page).slice(0, MAX_RUNS);
	const total = asNumber(asObject(page)?.total_count) ?? listed.length;
	const runs: RunPages[] = [];
	for (const run of listed) {
		const jobs = parseJobs(
			await http.github(
				`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100&filter=latest`,
			),
		);
		const annotations = new Map<number, readonly Annotation[]>();
		for (const job of routeCheckRuns(jobs))
			annotations.set(
				job.id,
				parseAnnotations(
					await http.github(
						`/repos/${repository}/check-runs/${job.id}/annotations?per_page=50`,
					),
				),
			);
		runs.push({ run, jobs, annotations });
	}
	return { runs, truncated: total > MAX_RUNS };
}

export type OidcSource = Readonly<{ requestUrl: string; requestToken: string }>;

/** The relay's status for this repository, through a workflow OIDC token; `unknown` on any failure. */
export async function readStatus(
	http: Http,
	repository: string,
	origin: string | undefined,
	oidc: OidcSource,
): Promise<StatusReading> {
	if (!origin)
		return { kind: "unknown", why: "no relay named in .hobo/ci.json" };
	if (!oidc.requestUrl || !oidc.requestToken)
		return {
			kind: "unknown",
			why: "no OIDC token (not in a workflow with id-token: write)",
		};
	try {
		const tokenResponse = await http.raw(
			`${oidc.requestUrl}&audience=${encodeURIComponent(origin)}`,
			{ Authorization: `bearer ${oidc.requestToken}` },
		);
		if (!tokenResponse.ok)
			return {
				kind: "unknown",
				why: `OIDC token request answered ${tokenResponse.status}`,
			};
		const token = asText(
			asObject(parseJson(await tokenResponse.text()))?.value,
		);
		if (!token)
			return { kind: "unknown", why: "OIDC token missing from the answer" };
		const response = await http.raw(
			`${origin}/v1/fleet/reporters/${repository}`,
			{ Authorization: `Bearer ${token}`, Accept: "application/json" },
		);
		if (!response.ok)
			return {
				kind: "unknown",
				why: `status route answered ${response.status}`,
			};
		const list = parseStatusList(parseJson(await response.text()), repository);
		return list
			? { kind: "known", list }
			: { kind: "unknown", why: "status route answered something else" };
	} catch (error) {
		if (error instanceof BudgetSpent) throw error;
		return {
			kind: "unknown",
			why: `status route unreachable (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}

export type IssueOptions = Readonly<{ assignee: string; runUrl: string }>;

/** Opens an issue per breached signal, or comments on the open one with its prefix. Never closes. */
export async function raiseIssues(
	http: Http,
	repository: string,
	report: HealthReport,
	options: IssueOptions,
): Promise<string[]> {
	const breached = SIGNALS.filter(
		(signal) => report.signals[signal].state === "breach",
	);
	if (breached.length === 0) return [];
	const open = asList(
		await http.github(
			`/repos/${repository}/issues?labels=${ISSUE_LABEL}&state=open&per_page=100`,
		),
	).flatMap((entry) => {
		const issue = asObject(entry);
		const number = asNumber(issue?.number);
		// The issues list also returns pull requests; they are not ours.
		if (number === undefined || issue?.pull_request !== undefined) return [];
		return [{ number, title: asText(issue?.title) ?? "" }];
	});
	const done: string[] = [];
	for (const signal of breached) {
		const body = issueBody(signal, report, options.runUrl);
		const existing = open.find((issue) =>
			issue.title.startsWith(issuePrefix(signal)),
		);
		if (existing) {
			await http.github(
				`/repos/${repository}/issues/${existing.number}/comments`,
				{ method: "POST", body: JSON.stringify({ body }) },
			);
			done.push(`${signal}: commented on #${existing.number}`);
			continue;
		}
		const issue = {
			title: issueTitle(signal, report.signals[signal]),
			body,
			labels: [ISSUE_LABEL],
		};
		let created: JsonValue | undefined;
		try {
			created = await http.github(`/repos/${repository}/issues`, {
				method: "POST",
				body: JSON.stringify(
					options.assignee
						? { ...issue, assignees: [options.assignee] }
						: issue,
				),
			});
		} catch (error) {
			// An assignee GitHub will not take (an organization, no access) is
			// not a reason to stay silent.
			if (
				!options.assignee ||
				!(error instanceof Error ? error.message : String(error)).includes(
					" 422 ",
				)
			)
				throw error;
			created = await http.github(`/repos/${repository}/issues`, {
				method: "POST",
				body: JSON.stringify(issue),
			});
		}
		done.push(
			`${signal}: opened #${asNumber(asObject(created)?.number) ?? "?"}`,
		);
	}
	return done;
}

// --- Entry ---

function positive(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function repositoryFrom(env: NodeJS.ProcessEnv): string {
	if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
	const url = execFileSync("git", ["remote", "get-url", "origin"], {
		encoding: "utf8",
	}).trim();
	const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
	if (!match?.[1]) throw new Error("set GITHUB_REPOSITORY (owner/name)");
	return match[1];
}

function readText(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return "";
	}
}

const NOT_COMPUTED: SignalResult = {
	state: "unknown",
	summary: "not computed",
	evidence: [],
};

export type MainIo = Readonly<{
	fetch: typeof fetch;
	now: () => number;
	log: (line: string) => void;
	/** The contents of `.hobo/ci.json`. */
	relayConfig: string;
}>;

const defaultIo = (): MainIo => ({
	fetch,
	now: Date.now,
	log: (line) => console.log(line),
	relayConfig: readText(".hobo/ci.json"),
});

/**
 * Exit codes: 0 clear (or a dry run that read its window), 1 a breach, 2 the
 * window could not be read (rate limit, budget, API failure) or the issues
 * could not be written. A run that could not read its window opens no issue
 * and does not move the window.
 */
export async function main(
	argv: readonly string[] = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
	io: MainIo = defaultIo(),
): Promise<number> {
	const nowMs = io.now();
	const dryRun = argv.includes("--dry-run") || env.CI_HEALTH_DRY_RUN === "true";
	const repository = repositoryFrom(env);
	const http = createHttp({
		token: env.GITHUB_TOKEN || env.GH_TOKEN || "",
		apiUrl: env.GITHUB_API_URL || "https://api.github.com",
		fetch: io.fetch,
	});
	const thresholds: Thresholds = {
		stallMinutes: positive(env.CI_HEALTH_STALL_MINUTES, DEFAULT_STALL_MINUTES),
		paidMinutesPerWindow: positive(
			env.CI_HEALTH_PAID_MINUTES_PER_WINDOW,
			DEFAULT_PAID_MINUTES_PER_WINDOW,
		),
	};
	const windowEnd = new Date(nowMs).toISOString();
	let windowStart = new Date(nowMs - DEFAULT_WINDOW_MS).toISOString();
	let previous: PreviousReport | undefined;
	let report: HealthReport;
	try {
		previous = await readPreviousReport(http, repository, nowMs, io.log);
		if (previous) windowStart = previous.windowEnd;
		const window = await readWindow(http, repository, windowStart, windowEnd);
		const status = await readStatus(
			http,
			repository,
			parseRelayOrigin(io.relayConfig),
			{
				requestUrl: env.ACTIONS_ID_TOKEN_REQUEST_URL ?? "",
				requestToken: env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ?? "",
			},
		);
		report = evaluate({
			repository,
			data: { runs: window.runs, status },
			windowStart,
			windowEnd,
			nowMs,
			thresholds,
			previous,
			truncated: window.truncated,
			requests: http.requests(),
			dryRun,
		});
	} catch (error) {
		// The window does not move: the next run reads it again.
		report = {
			v: 1,
			repository,
			windowStart,
			windowEnd: windowStart,
			generatedAt: windowEnd,
			dryRun,
			outcome: "failed",
			failure:
				error instanceof RateLimited
					? `rate limited: ${error.message}`
					: error instanceof Error
						? error.message
						: String(error),
			truncated: false,
			runs: 0,
			requests: http.requests(),
			statusRoute: previous?.statusRoute ?? "known",
			statusWhy: "",
			signals: {
				H1: NOT_COMPUTED,
				H2: NOT_COMPUTED,
				H3: NOT_COMPUTED,
				H4: NOT_COMPUTED,
				H6: NOT_COMPUTED,
				H8: NOT_COMPUTED,
				H10: NOT_COMPUTED,
			},
			paidMinutes: {
				total: 0,
				byRefusal: { relay: 0, queue: 0, none: 0, fallback: 0, unrouted: 0 },
			},
		};
	}
	const markdown = renderReport(report);
	io.log(markdown);
	writeFileSync(
		env.CI_HEALTH_REPORT_PATH || REPORT_FILE,
		`${JSON.stringify(report, null, 2)}\n`,
	);
	if (env.GITHUB_STEP_SUMMARY)
		appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
	if (report.outcome === "failed") return 2;
	if (dryRun) {
		io.log("dry run: no issue written");
		return 0;
	}
	if (report.outcome === "clear") return 0;
	const runUrl =
		env.GITHUB_RUN_ID && env.GITHUB_SERVER_URL
			? `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
			: "";
	try {
		for (const line of await raiseIssues(http, repository, report, {
			assignee: env.CI_HEALTH_ASSIGNEE ?? "",
			runUrl,
		}))
			io.log(line);
	} catch (error) {
		io.log(
			`could not raise issues: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	}
	return 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
	process.exitCode = await main();
