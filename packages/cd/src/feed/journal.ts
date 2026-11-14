// Journal side of the delivery feed: per-Camp fenced leases, status reports
// and checkpoints over the DurableEventStore. Semantics match the in-process
// transport (WP7): the lease is the durable subscription `cd:camp:<campId>`
// with partition = Camp and holder = `<reconcilerId>/<holderId>` (I4); reports
// renew the lease, then append fenced to `cd-camp-status-<id>` (never the
// spec stream); checkpoints are fenced and monotonic.
import { createHash } from "node:crypto";
import { toJson } from "@bufbuild/protobuf";
import {
	type DurableEventStore,
	type EventInput,
	type EventPosition,
	EventStoreError,
	type FenceToken,
	type JsonObject,
	type PrincipalRef,
} from "@hobo/core";
import {
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
} from "../_generated/cd_pb.js";
import { messageOf } from "../agent/errors.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	CD_SUBSCRIPTIONS,
} from "../events.js";
import type {
	CampId,
	Outcome,
	ReconcilerId,
	ReconcilerLease,
} from "../ports.js";
import { feedRefusal } from "./errors.js";

// public-contract: schema id of reconcile status event bodies (shared with WP7's in-process transport).
export const RECONCILE_STATUS_SCHEMA = "hobo.cd.reconcile-status/v1" as const;

const MAX_ATTEMPTS = 3;

export function leaseHolder(reconcilerId: string, holderId: string): string {
	return `${reconcilerId}/${holderId}`;
}

function subscription(campId: string) {
	return { subscriptionId: CD_SUBSCRIPTIONS.camp(campId), partitionId: campId };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: JavaScript catch values are untrusted; only EventStoreError codes are read.
function codeOf(error: unknown): string {
	return error instanceof EventStoreError ? error.code : "";
}

function principalFor(reconcilerId: string): PrincipalRef {
	return { kind: "agent", id: `cd-reconciler:${reconcilerId}` };
}

/** Status events for one observation, in order (same mapping as WP7). */
export function statusEventsFor(
	observation: ReconcileObservationRecord,
	idempotencyPrefix: string,
): readonly EventInput[] {
	// SAFETY: toJson of a message is always a JSON object.
	const body = toJson(
		ReconcileObservationRecordSchema,
		observation,
	) as JsonObject;
	const types: string[] = [];
	if (observation.status === ReconcileStatus.CONVERGING)
		types.push(CD_EVENTS.ReconcileStarted);
	types.push(CD_EVENTS.StatusObserved);
	if (observation.status === ReconcileStatus.CONVERGED)
		types.push(CD_EVENTS.Converged);
	if (observation.status === ReconcileStatus.BLOCKED)
		types.push(CD_EVENTS.ReconcileBlocked);
	return types.map((type) => ({
		type,
		data: { schema: RECONCILE_STATUS_SCHEMA, observation: body },
		meta: { idempotencyKey: `${idempotencyPrefix}:${type}` },
	}));
}

export type FeedJournal = ReturnType<typeof createFeedJournal>;

export function createFeedJournal(
	d: Readonly<{ store: DurableEventStore; tenant: string }>,
) {
	const store = d.store;

	async function claim(
		input: Readonly<{
			reconcilerId: ReconcilerId;
			campId: CampId;
			holderId: string;
			ttlMs: number;
		}>,
	): Promise<Outcome<ReconcilerLease>> {
		if (!store.claimSubscription)
			return feedRefusal(
				"lease-unsupported",
				"the event store has no subscription leases",
				input.campId,
			);
		try {
			const lease = await store.claimSubscription({
				...subscription(input.campId),
				holderId: leaseHolder(input.reconcilerId, input.holderId),
				leaseTtlMs: input.ttlMs,
			});
			return {
				ok: true,
				value: Object.freeze({
					reconcilerId: input.reconcilerId,
					campId: input.campId,
					holderId: input.holderId,
					fence: lease.fenceToken,
					expiresAtMs: Date.parse(lease.expiresAt),
				}),
			};
		} catch (error) {
			const code = codeOf(error);
			if (code === "STALE_FENCE" || code.endsWith("LEASE_CONFLICT"))
				return feedRefusal(
					"lease-held",
					`Camp ${input.campId} is leased by another reconciler`,
					input.campId,
				);
			return feedRefusal("store-unavailable", messageOf(error), input.campId);
		}
	}

	async function renew(
		lease: ReconcilerLease,
		ttlMs: number = CD_DEFAULTS.leaseTtlMs,
	): Promise<Outcome<ReconcilerLease>> {
		if (!store.renewSubscription)
			return feedRefusal(
				"lease-unsupported",
				"the event store cannot renew leases",
				lease.campId,
			);
		try {
			const renewed = await store.renewSubscription({
				...subscription(lease.campId),
				holderId: leaseHolder(lease.reconcilerId, lease.holderId),
				fenceToken: lease.fence,
				leaseTtlMs: ttlMs,
			});
			return {
				ok: true,
				value: Object.freeze({
					...lease,
					expiresAtMs: Date.parse(renewed.expiresAt),
				}),
			};
		} catch (error) {
			const code = codeOf(error);
			if (code === "STALE_FENCE" || code.endsWith("LEASE_CONFLICT"))
				return feedRefusal(
					"stale-fence",
					`lease fence ${lease.fence} on ${lease.campId} is no longer current`,
					lease.campId,
				);
			return feedRefusal("store-unavailable", messageOf(error), lease.campId);
		}
	}

	async function release(lease: ReconcilerLease): Promise<void> {
		if (!store.releaseSubscription) return;
		try {
			await store.releaseSubscription({
				...subscription(lease.campId),
				holderId: leaseHolder(lease.reconcilerId, lease.holderId),
				fenceToken: lease.fence,
			});
		} catch {
			// A lost lease needs no release; expiry frees it.
		}
	}

	async function statusSeq(stream: string): Promise<number> {
		const head = store.getStreamHead?.(stream);
		if (head) return head.revision;
		let seq = 0;
		for await (const event of store.read(stream)) seq = event.seq;
		return seq;
	}

	async function report(
		lease: ReconcilerLease,
		observation: ReconcileObservationRecord,
	): Promise<Outcome<EventPosition>> {
		const current = await renew(lease);
		if (!current.ok) return current;
		const stream = CD_STREAMS.campStatus(lease.campId);
		const bytes = toJson(ReconcileObservationRecordSchema, observation);
		const digest = createHash("sha256")
			.update(JSON.stringify(bytes))
			.digest("hex")
			.slice(0, 32);
		const events = [
			...statusEventsFor(
				observation,
				`${lease.campId}:${lease.fence}:${digest}`,
			),
		];
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			try {
				const result = await store.append(stream, events, {
					expectedSeq: await statusSeq(stream),
					actor: principalFor(lease.reconcilerId),
					tenant: d.tenant,
					fenceToken: lease.fence,
				});
				const last = result.lastPosition ?? (await lastPosition(stream));
				return { ok: true, value: last };
			} catch (error) {
				const code = codeOf(error);
				if (code === "OPTIMISTIC_SEQUENCE_CONFLICT") continue;
				if (code === "STALE_FENCE" || code === "MISSING_FENCE")
					return feedRefusal(
						"stale-fence",
						`status append refused for fence ${lease.fence}`,
						lease.campId,
					);
				return feedRefusal("store-unavailable", messageOf(error), lease.campId);
			}
		}
		return feedRefusal(
			"report-refused",
			"status stream kept changing under a single-writer lease",
			lease.campId,
		);
	}

	async function lastPosition(stream: string): Promise<EventPosition> {
		let last = 0n;
		for await (const { position } of store.readAll({
			filter: { streamId: stream },
		}))
			last = position;
		// SAFETY: positions come from the journal.
		return last as EventPosition;
	}

	async function checkpoint(
		lease: ReconcilerLease,
		position: EventPosition,
	): Promise<Outcome<EventPosition>> {
		if (!store.commitCheckpoint)
			return feedRefusal(
				"lease-unsupported",
				"the event store cannot commit checkpoints",
				lease.campId,
			);
		try {
			const committed = await store.commitCheckpoint({
				...subscription(lease.campId),
				position,
				fenceToken: lease.fence,
			});
			return { ok: true, value: committed.position };
		} catch (error) {
			const code = codeOf(error);
			if (code === "CHECKPOINT_REGRESSION")
				return feedRefusal(
					"checkpoint-regression",
					`checkpoint ${position} is behind the committed one`,
					lease.campId,
				);
			if (code === "STALE_FENCE")
				return feedRefusal(
					"stale-fence",
					`checkpoint refused for fence ${lease.fence}`,
					lease.campId,
				);
			return feedRefusal("store-unavailable", messageOf(error), lease.campId);
		}
	}

	async function committed(campId: string): Promise<EventPosition | undefined> {
		if (!store.loadCheckpoint) return undefined;
		return (await store.loadCheckpoint(subscription(campId)))?.position;
	}

	/** Position of the last desired-state change on the Camp's spec stream. */
	async function specHead(campId: string): Promise<EventPosition | undefined> {
		let head: EventPosition | undefined;
		let seenSet = false;
		for await (const { position, event } of store.readAll({
			filter: { streamId: CD_STREAMS.campSpec(campId) },
		})) {
			if (event.type === CD_EVENTS.SetCreated) seenSet = true;
			if (seenSet && CHANGE_TYPES.has(event.type)) head = position;
		}
		return head;
	}

	return Object.freeze({
		claim,
		renew,
		release,
		report,
		checkpoint,
		committed,
		specHead,
	});
}

const CHANGE_TYPES: ReadonlySet<string> = new Set([
	CD_EVENTS.SetCreated,
	CD_EVENTS.PolicyBindingChanged,
	CD_EVENTS.CampManagementChanged,
]);

export type { FenceToken };
