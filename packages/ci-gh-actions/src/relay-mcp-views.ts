import { create, fromJsonString } from "@bufbuild/protobuf";
import {
	ACTIVE_STATES,
	type CiEvent,
	eventJob,
	type Job,
	type Lease,
	LeaseSchema,
	type SequencedCiEvent,
} from "@hobo/ci";
import {
	type RelayMcpEvent,
	RelayMcpEventSchema,
	type RelayMcpJob,
	RelayMcpJobSchema,
	type RelayMcpLease,
	RelayMcpLeaseSchema,
	type RelayMcpQuarantinedDelivery,
	RelayMcpQuarantinedDeliverySchema,
} from "./_generated/relay_mcp_pb.js";
import type { QuarantinedDelivery } from "./account-operations.js";
import type { CursorCodec } from "./relay-mcp-cursor.js";

/**
 * The views the relay's MCP server returns. Each is assembled one named field
 * at a time, so a field added to a lease, a job or an event is not exposed
 * until someone lists it here. An event's stored detail is read for a handful
 * of identifying fields and never returned.
 */

/** A lease for triage: where it is, what it runs, what it cost. */
export function leaseView(lease: Lease): RelayMcpLease {
	return create(RelayMcpLeaseSchema, {
		id: lease.id,
		state: lease.state,
		active: ACTIVE_STATES.has(lease.state),
		repository: lease.repository,
		jobId: lease.jobId,
		jobName: lease.jobName,
		runId: lease.originalRunId,
		runAttempt: lease.runAttempt,
		provider: lease.provider,
		offerId: lease.offerId,
		runnerName: lease.runnerName,
		createdAt: lease.createdAt,
		dispatchingAt: lease.dispatchingAt,
		settledAt: lease.settledAt,
		queueDeadlineAt: lease.queueDeadlineAt,
		hostRunId: lease.hostRunId,
		actualJobId: lease.actualJobId,
		billedMinutes: lease.billedMinutes,
		paidMicros: lease.paidMicros,
		memoryClass: lease.memoryClass,
		sandboxStage: lease.sandboxStage,
	});
}

/** A queued job that has no lease yet. */
export function jobView(job: Job): RelayMcpJob {
	return create(RelayMcpJobSchema, {
		id: job.id,
		runId: job.runId,
		runAttempt: job.runAttempt,
		repository: job.repository,
		name: job.name,
		labels: job.labels,
		isolatedRequired: job.isolatedRequired,
		memoryClass: job.memoryClass,
		queueDeadlineAt: job.queueDeadlineAt,
	});
}

/** The lease a lease event recorded, when its detail is that lease. */
function eventLease(event: CiEvent): Lease | undefined {
	if (!event.leaseId) return undefined;
	try {
		const lease = fromJsonString(LeaseSchema, event.detail);
		return lease.id === event.leaseId ? lease : undefined;
	} catch {
		return undefined;
	}
}

/**
 * One journal event: its cursor, type and time, and the job or lease it is
 * about. The cursor is the account's own; the journal position is not shown.
 */
export function eventView(
	entry: SequencedCiEvent,
	cursors: Pick<CursorCodec, "encode">,
): RelayMcpEvent {
	const event = entry.event;
	const view = create(RelayMcpEventSchema, {
		cursor: cursors.encode(entry.seq),
		type: event?.type ?? "",
		at: event?.at ?? "",
		leaseId: event?.leaseId ?? "",
	});
	if (!event) return view;
	const job = eventJob(event);
	if (job) {
		view.repository = job.repository;
		view.jobId = job.id;
		view.jobName = job.name;
		view.runId = job.runId;
		view.runAttempt = job.runAttempt;
		return view;
	}
	const lease = eventLease(event);
	if (lease) {
		view.state = lease.state;
		view.repository = lease.repository;
		view.jobId = lease.jobId;
		view.jobName = lease.jobName;
		view.runId = lease.originalRunId;
		view.runAttempt = lease.runAttempt;
	}
	return view;
}

/** A quarantined delivery's identity and history; never its body. */
export function quarantinedDeliveryView(
	delivery: QuarantinedDelivery,
): RelayMcpQuarantinedDelivery {
	return create(RelayMcpQuarantinedDeliverySchema, {
		deliveryId: delivery.deliveryId,
		event: delivery.event,
		installationId: delivery.installationId,
		repositoryId: delivery.repositoryId,
		receivedAt: delivery.receivedAt,
		attempts: delivery.attempts,
	});
}
