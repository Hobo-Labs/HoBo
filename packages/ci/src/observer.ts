import type {
	CiEventPage,
	ConfigurationState,
	Job,
	Lease,
	SequencedCiEvent,
} from "./_generated/ci_pb.js";
import type { EventCursor, LeaseEventsQuery } from "./event-log.js";

/** A webhook delivery set aside after it failed too many times. Never its body. */
export type QuarantinedWebhook = Readonly<{
	deliveryId: string;
	event: string;
	installationId: number;
	repositoryId: number;
	receivedAt: string;
	attempts: number;
}>;

/**
 * What something that only watches the relay reads: an agent following job
 * state, a dashboard. These reads return the last committed state and never
 * wait for, or hold, the partition's write lock, so however many observers
 * read, webhook admission and the worker tick are not queued behind them.
 */
export interface CiObserver {
	configuration(): Promise<ConfigurationState | undefined>;
	get(id: string): Promise<Lease | undefined>;
	accountLeases(accountId: string): Promise<Lease[]>;
	pendingJobs(): Promise<Job[]>;
	/** The journal's newest position: where "from now on" starts. */
	journalHead(): Promise<number>;
	/** An account's events after a journal position, or its newest ones. */
	eventsSince(cursor: EventCursor): Promise<CiEventPage>;
	/** The newest events of one of the account's leases, in journal order. */
	leaseEvents(query: LeaseEventsQuery): Promise<SequencedCiEvent[]>;
	quarantinedWebhooks(
		accountId: string,
		expectedRevision: number,
	): Promise<QuarantinedWebhook[]>;
}
