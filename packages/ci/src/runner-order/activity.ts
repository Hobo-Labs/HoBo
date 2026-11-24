import type { RunnerRouteEvent } from "../_generated/relay_job_pb.js";
import type { RunnerRouteDecision } from "../_generated/runner_route_pb.js";
import { describeDecision, describeSkip } from "./decide.js";
import type { RouteJournal } from "./ports.js";

// public-contract: how an activity entry ended; `pending` was asked and has no answer yet.
export const ACTIVITY_OUTCOMES = [
	"routed",
	"waiting",
	"none",
	"pending",
] as const;
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

// public-contract: entries in a page when the caller names no limit.
export const ACTIVITY_PAGE_SIZE = 50;
// public-contract: the most entries one page returns.
export const ACTIVITY_PAGE_MAX = 500;
export const ACTIVITY_JOURNAL_READ_LIMIT = 20_000;

export type ActivityEntry = Readonly<{
	key: string;
	jobId: string;
	repository: string;
	runId: number;
	runAttempt: number;
	job: string;
	event: string;
	mode: string;
	node: string;
	requestedAtMs: number | undefined;
	decidedAtMs: number | undefined;
	atMs: number;
	outcome: ActivityOutcome;
	runner: string;
	step: string;
	machineId: string;
	unhealthyFallback: boolean;
	why: string;
	passedOver: readonly string[];
}>;

export type ActivityCursor = Readonly<{ atMs: number; key: string }>;

export type ActivityFilter = Readonly<{
	repository?: string | undefined;
	outcome?: ActivityOutcome | undefined;
	step?: string | undefined;
	machineId?: string | undefined;
	sinceMs?: number | undefined;
	limit?: number | undefined;
	after?: ActivityCursor | undefined;
}>;

export type ActivityPage = Readonly<{
	entries: readonly ActivityEntry[];
	next: ActivityCursor | undefined;
}>;

const PENDING_WHY = "Asked; no answer is recorded yet.";

function entryKey(event: RunnerRouteEvent): string {
	if (event.jobId !== "") return event.jobId;
	const request = event.request;
	return [
		(request?.repository ?? "").toLowerCase(),
		request?.runId ?? 0,
		request?.runAttempt ?? 0,
		request?.job ?? "",
	].join("#");
}

function passedOver(decision: RunnerRouteDecision): readonly string[] {
	return Object.freeze([
		...decision.skipped.map(describeSkip),
		...decision.notInOrder.map(
			(key) => `${key}: not in the runner order, so never tried`,
		),
	]);
}

function outcomeOf(decision: RunnerRouteDecision): ActivityOutcome {
	return (
		ACTIVITY_OUTCOMES.find((outcome) => outcome === decision.outcome) ?? "none"
	);
}

type Gathered = {
	requested: RunnerRouteEvent | undefined;
	decided: RunnerRouteEvent | undefined;
};

function entryOf(key: string, gathered: Gathered): ActivityEntry | undefined {
	const source = gathered.decided ?? gathered.requested;
	const request = source?.request;
	if (!source || !request) return undefined;
	const decision = gathered.decided?.decision;
	return Object.freeze({
		key,
		jobId: source.jobId,
		repository: request.repository,
		runId: Number(request.runId),
		runAttempt: request.runAttempt,
		job: request.job,
		event: request.event,
		mode: source.mode,
		node: source.node,
		requestedAtMs: gathered.requested?.atMs,
		decidedAtMs: gathered.decided?.atMs,
		atMs: source.atMs,
		outcome: decision ? outcomeOf(decision) : "pending",
		runner: decision?.runner ?? "",
		step: decision?.step ?? "",
		machineId: decision?.machineId ?? "",
		unhealthyFallback: decision?.unhealthyFallback ?? false,
		why: decision ? describeDecision(decision) : PENDING_WHY,
		passedOver: decision ? passedOver(decision) : Object.freeze([]),
	});
}

function gather(
	events: readonly RunnerRouteEvent[],
): ReadonlyMap<string, Gathered> {
	const jobs = new Map<string, Gathered>();
	for (const event of events) {
		const key = entryKey(event);
		const gathered = jobs.get(key) ?? {
			requested: undefined,
			decided: undefined,
		};
		if (event.type === "runner.route.Decided" && event.decision) {
			if (!gathered.decided || event.atMs < gathered.decided.atMs)
				gathered.decided = event;
		} else if (
			event.type === "runner.route.Requested" &&
			(!gathered.requested || event.atMs < gathered.requested.atMs)
		)
			gathered.requested = event;
		jobs.set(key, gathered);
	}
	return jobs;
}

function newerFirst(left: ActivityCursor, right: ActivityCursor): number {
	if (left.atMs !== right.atMs) return right.atMs - left.atMs;
	return left.key < right.key ? 1 : left.key > right.key ? -1 : 0;
}

function matches(entry: ActivityEntry, filter: ActivityFilter): boolean {
	const repository = filter.repository?.toLowerCase();
	return (
		(repository === undefined ||
			entry.repository.toLowerCase() === repository) &&
		(filter.outcome === undefined || entry.outcome === filter.outcome) &&
		(filter.step === undefined || entry.step === filter.step) &&
		(filter.machineId === undefined || entry.machineId === filter.machineId) &&
		(filter.sinceMs === undefined || entry.atMs >= filter.sinceMs) &&
		(filter.after === undefined || newerFirst(filter.after, entry) < 0)
	);
}

function pageSize(limit: number | undefined): number {
	if (limit === undefined) return ACTIVITY_PAGE_SIZE;
	return Math.max(0, Math.min(ACTIVITY_PAGE_MAX, Math.floor(limit)));
}

export function activityFeed(
	events: readonly RunnerRouteEvent[],
	filter: ActivityFilter = {},
): ActivityPage {
	const size = pageSize(filter.limit);
	const found: ActivityEntry[] = [];
	for (const [key, gathered] of gather(events)) {
		const entry = entryOf(key, gathered);
		if (entry && matches(entry, filter)) found.push(entry);
	}
	found.sort(newerFirst);
	const entries = Object.freeze(found.slice(0, size));
	const last = entries.at(-1);
	return Object.freeze({
		entries,
		next:
			found.length > size && last
				? Object.freeze({ atMs: last.atMs, key: last.key })
				: undefined,
	});
}

export async function journalActivity(
	journal: RouteJournal,
	accountId: string,
	filter: ActivityFilter = {},
): Promise<ActivityPage> {
	const events = await journal.decisions({
		accountId,
		repository: filter.repository,
		sinceMs: 0,
		limit: ACTIVITY_JOURNAL_READ_LIMIT,
	});
	return activityFeed(events, filter);
}
