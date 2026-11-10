import { create, fromJsonString } from "@bufbuild/protobuf";
import {
	type CiEvent,
	type CiEventPage,
	CiEventPageSchema,
	type Connection,
	type Job,
	JobSchema,
	type SequencedCiEvent,
} from "./_generated/ci_pb.js";

/** One cursor read of an account's events. Omit `after` for the newest events. */
export type EventCursor = Readonly<{
	accountId: string;
	/** Read events after this journal position; the `cursor` of an earlier page. */
	after?: number;
	/** The most events to return, 1 to 500. */
	limit: number;
}>;

/** The newest events of one lease, read by the lease's id. */
export type LeaseEventsQuery = Readonly<{
	accountId: string;
	leaseId: string;
	/** The most events to return, 1 to 500. */
	limit: number;
}>;

/**
 * How many of the journal's rows one read looks along. The journal holds
 * every account's events, so this bounds the work of a read whatever the
 * other accounts are doing; a page says when the bound cut it short.
 */
export const EVENT_SCAN_SPAN = 10_000;
const EVENT_PAGE_LIMIT = 500;

/** Events recorded for a job before, or apart from, any lease. Their detail is the job. */
const JOB_EVENT_TYPES: ReadonlySet<string> = new Set([
	"ci.JobQueued",
	"ci.JobExpired",
	"ci.JobCompleted",
	"ci.JobAssignmentCleared",
]);

/** The job a job event was recorded for; undefined for every other event. */
export function eventJob(event: CiEvent): Job | undefined {
	if (!JOB_EVENT_TYPES.has(event.type)) return undefined;
	try {
		return fromJsonString(JobSchema, event.detail);
	} catch {
		return undefined;
	}
}

/**
 * The account a job belongs to: the one whose connection holds its repository
 * and installation. A store asks this when it writes a job event, so the
 * event keeps the owner of that moment however the connection moves later.
 * Empty when no account has connected the repository.
 */
export function jobAccountId(
	connections: readonly Connection[],
	job: Job,
): string {
	return (
		connections.find(
			(connection) =>
				connection.repositoryId === job.repositoryId &&
				connection.installationId === job.installationId,
		)?.accountId ?? ""
	);
}

/** Whether a job runs in a repository this account has connected now. */
export function accountOwnsJob(
	connections: readonly Connection[],
	accountId: string,
	job: Job,
): boolean {
	return accountId !== "" && jobAccountId(connections, job) === accountId;
}

function pageLimit(limit: number): number {
	if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_PAGE_LIMIT)
		throw new Error("invalid event page limit");
	return limit;
}

/** The validated bounds of a cursor read. */
export function eventCursorBounds(cursor: EventCursor) {
	if (!cursor.accountId) throw new Error("event cursor needs an account");
	if (
		cursor.after !== undefined &&
		(!Number.isSafeInteger(cursor.after) || cursor.after < 0)
	)
		throw new Error("invalid event cursor");
	return {
		accountId: cursor.accountId,
		after: cursor.after,
		limit: pageLimit(cursor.limit),
	};
}

/** The validated bounds of a read of one lease's events. */
export function leaseEventsBounds(query: LeaseEventsQuery) {
	if (!query.accountId || !query.leaseId)
		throw new Error("lease events need an account and a lease");
	return {
		accountId: query.accountId,
		leaseId: query.leaseId,
		limit: pageLimit(query.limit),
	};
}

/** The journal positions a read examines: after `from`, up to and including `to`. */
export type EventScan = Readonly<{ from: number; to: number; head: number }>;

/**
 * Which positions a read looks along in a journal whose positions are dense
 * (one row each, as in a SQLite partition), given its newest position. A
 * cursor read starts at its cursor; a read of the newest events ends at the
 * head. Either way it covers at most `EVENT_SCAN_SPAN` rows. A journal that
 * shares its sequence with others finds the same edges by counting rows.
 */
export function eventScan(cursor: EventCursor, head: number): EventScan {
	const { after } = eventCursorBounds(cursor);
	if (after === undefined)
		return { from: Math.max(0, head - EVENT_SCAN_SPAN), to: head, head };
	return {
		from: after,
		to: Math.max(after, Math.min(head, after + EVENT_SCAN_SPAN)),
		head,
	};
}

/**
 * Build a page from the account's events a store found in a scan.
 * For a cursor read `found` holds the oldest events of the scan, in journal
 * order, one more than the page's limit when there are that many. For a read
 * of the newest events it holds the newest ones, in journal order, at most
 * the limit.
 */
export function accountEventPage(
	found: readonly SequencedCiEvent[],
	cursor: EventCursor,
	scan: EventScan,
): CiEventPage {
	const { after, limit } = eventCursorBounds(cursor);
	if (after === undefined)
		return create(CiEventPageSchema, {
			events: found.slice(-limit),
			cursor: scan.head,
			// Fewer than asked for, and the scan did not reach the journal's
			// start: there may be older events it never looked at.
			truncated: found.length < limit && scan.from > 0,
		});
	if (found.length > limit) {
		// A full page resumes after its last event, not after the scan.
		const events = found.slice(0, limit);
		return create(CiEventPageSchema, {
			events,
			cursor: events.at(-1)?.seq ?? scan.to,
			more: true,
		});
	}
	return create(CiEventPageSchema, {
		events: [...found],
		cursor: scan.to,
		more: scan.to < scan.head,
	});
}
