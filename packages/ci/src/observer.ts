import type {
	CiEventPage,
	ConfigurationState,
	Job,
	Lease,
	SequencedCiEvent,
} from "./_generated/ci_pb.js";
import type { EventCursor, LeaseEventsQuery } from "./event-log.js";

export type QuarantinedWebhook = Readonly<{
	deliveryId: string;
	event: string;
	installationId: number;
	repositoryId: number;
	receivedAt: string;
	attempts: number;
}>;

export interface CiObserver {
	configuration(): Promise<ConfigurationState | undefined>;
	get(id: string): Promise<Lease | undefined>;
	accountLeases(accountId: string): Promise<Lease[]>;
	pendingJobs(): Promise<Job[]>;
	journalHead(): Promise<number>;
	eventsSince(cursor: EventCursor): Promise<CiEventPage>;
	leaseEvents(query: LeaseEventsQuery): Promise<SequencedCiEvent[]>;
	quarantinedWebhooks(
		accountId: string,
		expectedRevision: number,
	): Promise<QuarantinedWebhook[]>;
}
