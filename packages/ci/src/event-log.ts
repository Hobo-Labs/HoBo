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

export type EventCursor = Readonly<{
	accountId: string;
	after?: number;
	limit: number;
}>;

export type LeaseEventsQuery = Readonly<{
	accountId: string;
	leaseId: string;
	limit: number;
}>;

const EVENT_PAGE_LIMIT = 500;

const JOB_EVENT_TYPES: ReadonlySet<string> = new Set([
	"ci.JobQueued",
	"ci.JobExpired",
	"ci.JobCompleted",
	"ci.JobAssignmentCleared",
]);

export function isJobEvent(event: CiEvent): boolean {
	return JOB_EVENT_TYPES.has(event.type);
}

export function eventJob(event: CiEvent): Job | undefined {
	if (!isJobEvent(event)) return undefined;
	try {
		return fromJsonString(JobSchema, event.detail);
	} catch {
		return undefined;
	}
}

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

export function leaseEventsBounds(query: LeaseEventsQuery) {
	if (!query.accountId || !query.leaseId)
		throw new Error("lease events need an account and a lease");
	return {
		accountId: query.accountId,
		leaseId: query.leaseId,
		limit: pageLimit(query.limit),
	};
}

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
			truncated: found.length > limit,
		});
	}
	const events = found.slice(0, limit);
	return create(CiEventPageSchema, {
		events,
		cursor: events.at(-1)?.seq ?? after,
		more: found.length > limit,
	});
}
