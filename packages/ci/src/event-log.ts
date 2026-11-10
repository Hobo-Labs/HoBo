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
	/** Read events after this log position; the `cursor` of an earlier page. */
	after?: number;
	/** The most events to return, 1 to 500. */
	limit: number;
}>;

/** The most log rows one cursor read examines before it returns. */
export const EVENT_SCAN_LIMIT = 1000;
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

/** Whether a job runs in a repository this account has connected. */
export function accountOwnsJob(
	connections: readonly Connection[],
	accountId: string,
	job: Job,
): boolean {
	return connections.some(
		(connection) =>
			connection.accountId === accountId &&
			connection.repositoryId === job.repositoryId &&
			connection.installationId === job.installationId,
	);
}

/**
 * Whether an event is this account's to read: one recorded for the account,
 * or a job event of a repository the account has connected. Events of the
 * whole partition, such as a configuration change, belong to no account.
 */
export function accountOwnsEvent(
	connections: readonly Connection[],
	accountId: string,
	event: CiEvent,
): boolean {
	if (event.accountId) return event.accountId === accountId;
	const job = eventJob(event);
	return !!job && accountOwnsJob(connections, accountId, job);
}

/** The validated bounds of a cursor read. */
export function eventCursorBounds(cursor: EventCursor) {
	if (!cursor.accountId) throw new Error("event cursor needs an account");
	if (
		!Number.isInteger(cursor.limit) ||
		cursor.limit < 1 ||
		cursor.limit > EVENT_PAGE_LIMIT
	)
		throw new Error("invalid event page limit");
	if (
		cursor.after !== undefined &&
		(!Number.isSafeInteger(cursor.after) || cursor.after < 0)
	)
		throw new Error("invalid event cursor");
	return {
		accountId: cursor.accountId,
		after: cursor.after,
		limit: cursor.limit,
	};
}

/**
 * Build a page from the log rows a store scanned for a cursor read.
 * `scanned` is in log order and holds at most `EVENT_SCAN_LIMIT` rows: those
 * after the cursor, or the newest ones when the read has no cursor.
 */
export function accountEventPage(
	scanned: readonly SequencedCiEvent[],
	connections: readonly Connection[],
	cursor: EventCursor,
): CiEventPage {
	const { accountId, after, limit } = eventCursorBounds(cursor);
	const owned = scanned.filter(
		(entry) =>
			!!entry.event && accountOwnsEvent(connections, accountId, entry.event),
	);
	if (after === undefined)
		// The newest events: the page ends at the end of the scanned log.
		return create(CiEventPageSchema, {
			events: owned.slice(-limit),
			cursor: scanned.at(-1)?.seq ?? 0,
		});
	const events = owned.slice(0, limit);
	// A full page resumes after its last event. A short one has examined every
	// scanned row, so the next read need not look at them again.
	const last =
		owned.length > limit ? events.at(-1)?.seq : (scanned.at(-1)?.seq ?? after);
	return create(CiEventPageSchema, { events, cursor: last ?? after });
}
