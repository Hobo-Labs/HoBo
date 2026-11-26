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

const EVENT_PAGE_LIMIT = 500;

/** Events recorded for a job before, or apart from, any lease. Their detail is the job. */
const JOB_EVENT_TYPES: ReadonlySet<string> = new Set([
	"ci.JobQueued",
	"ci.JobExpired",
	"ci.JobCompleted",
	"ci.JobAssignmentCleared",
]);

/** Whether an event is about a job itself, before or apart from any lease. */
export function isJobEvent(event: CiEvent): boolean {
	return JOB_EVENT_TYPES.has(event.type);
}

/** The job a job event was recorded for; undefined for every other event. */
export function eventJob(event: CiEvent): Job | undefined {
	if (!isJobEvent(event)) return undefined;
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

/**
 * Build a page from the account's events a store found by the account's index.
 * `found` is in journal order and holds one event more than the page's limit
 * when the account has that many: for a cursor read the oldest events after
 * the cursor, for a read of the newest events the newest ones.
 *
 * The page's cursor is the position of its last event, and the position the
 * read was given when it found none (zero for a read of the newest events).
 * It is always a position of the account's own, so it moves only when the
 * account's journal does.
 */
export function accountEventPage(
	found: readonly SequencedCiEvent[],
	cursor: EventCursor,
): CiEventPage {
	const { after, limit } = eventCursorBounds(cursor);
	if (after === undefined) {
		const events = found.slice(-limit);
		return create(CiEventPageSchema, {
			events,
			cursor: events.at(-1)?.seq ?? 0,
			// The page is full and the account has events older than it.
			truncated: found.length > limit,
		});
	}
	const events = found.slice(0, limit);
	return create(CiEventPageSchema, {
		events,
		cursor: events.at(-1)?.seq ?? after,
		// The page is full and the account has events after it.
		more: found.length > limit,
	});
}
