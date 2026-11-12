// The in-process ReconcilerTransport (conductor mode and `hobo up`). It is the
// journal-side half of the reconcile boundary; the HTTP transport in ./agent
// speaks the same contract over the delivery feed.
//
//   claim       durable subscription lease `cd:camp:<campId>`, partition =
//               Camp, holder = `<reconcilerId>/<holderId>`, so two reconcilers
//               with different ids can never both hold one Camp (I4).
//   feed        desired-state changes after the committed checkpoint, bounded
//               to the spec-stream head at call time. The first feed of each
//               lease re-delivers the Camp's current change when nothing newer
//               exists (at-least-once), so a restarted reconciler re-observes
//               without waiting for a new Set.
//   resolved    the verified resolved-set blob; a missing or corrupt blob is a
//               typed refusal, never a guess.
//   report      lease re-check, then a fenced append of the status events to
//               `cd-camp-status-<id>` (never the spec stream).
//   checkpoint  fenced, monotonic subscription checkpoint.
import { createHash } from "node:crypto";
import {
	type DurableEventStore,
	type EventPosition,
	EventStoreError,
	type FenceToken,
	type PrincipalRef,
} from "@hobo/core";
import { CampManagement, type SetRecord } from "../_generated/cd_pb.js";
import { CD_DEFAULTS, CD_STREAMS, CD_SUBSCRIPTIONS, CD_EVENTS } from "../events.js";
import type {
	CampId,
	CdBase,
	DesiredStateChange,
	DesiredStateReader,
	Outcome,
	PostureService,
	ReconcilerLease,
	ReconcilerTransport,
	TopologyReader,
} from "../ports.js";
import { messageOf, refuse } from "./errors.js";
import { observationJson, statusEventsFor } from "./status-events.js";
import { stableJson } from "./json.js";

export type InProcessTransportDeps = CdBase & {
	readonly desired: DesiredStateReader;
	readonly posture?: PostureService;
	readonly topology?: TopologyReader;
	/** Upper bound on one feed call when the spec head is never reached. */
	readonly feedTimeoutMs?: number;
};

// Spec-stream event types that produce a DesiredStateChange (WP4 contract).
const CHANGE_TYPES: ReadonlySet<string> = new Set([
	CD_EVENTS.SetCreated,
	CD_EVENTS.PolicyBindingChanged,
	CD_EVENTS.CampManagementChanged,
]);

/** Lease holder key: the reconciler id is part of it (I4). */
export function leaseHolder(reconcilerId: string, holderId: string): string {
	return `${reconcilerId}/${holderId}`;
}

function principalFor(reconcilerId: string): PrincipalRef {
	return { kind: "service", id: `cd-reconciler:${reconcilerId}` };
}

function codeOf(error: unknown): string {
	return error instanceof EventStoreError ? error.code : "";
}

function asPosition(value: bigint): EventPosition {
	// SAFETY: positions come from the journal or from a committed checkpoint.
	return value as EventPosition;
}

function asFence(value: bigint): FenceToken {
	// SAFETY: fence tokens are minted by the journal's subscription lease.
	return value as FenceToken;
}

export function createInProcessTransport(
	d: InProcessTransportDeps,
): ReconcilerTransport {
	const store: DurableEventStore = d.store;
	const ttls = new Map<string, number>();
	const delivered = new Set<string>();
	const feedTimeoutMs = d.feedTimeoutMs ?? CD_DEFAULTS.feedLongPollMs;
	const leaseKey = (lease: ReconcilerLease) =>
		`${lease.campId}#${lease.fence.toString(10)}`;
	const subscription = (campId: string) => ({
		subscriptionId: CD_SUBSCRIPTIONS.camp(campId),
		partitionId: campId,
	});

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

	async function adjust(change: DesiredStateChange, campId: CampId): Promise<DesiredStateChange> {
		const observeFields = d.posture
			? await d.posture.observeFields(campId)
			: change.observeFields;
		const topology = d.topology ? await d.topology.camp(campId) : undefined;
		// Most conservative wins: OBSERVE_ONLY from either source never applies.
		const management =
			topology?.management === CampManagement.OBSERVE_ONLY ||
			change.management === CampManagement.OBSERVE_ONLY
				? CampManagement.OBSERVE_ONLY
				: change.management === CampManagement.UNSPECIFIED
					? CampManagement.MANAGED
					: change.management;
		return Object.freeze({
			...change,
			observeFields: Object.freeze([...observeFields]),
			management,
		});
	}

	async function* feed(
		input: Readonly<{ lease: ReconcilerLease; signal: AbortSignal }>,
	): AsyncIterable<DesiredStateChange> {
		const { lease, signal } = input;
		if (!store.loadCheckpoint) return;
		const checkpoint = await store.loadCheckpoint(subscription(lease.campId));
		const head = await specHead(lease.campId);
		if (head === undefined || signal.aborted) return;
		const key = leaseKey(lease);
		const redeliver = !delivered.has(key);
		delivered.add(key);
		const after = checkpoint?.position;
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal.addEventListener("abort", onAbort);
		const timer = setTimeout(() => controller.abort(), feedTimeoutMs);
		let current: DesiredStateChange | undefined;
		const newer: DesiredStateChange[] = [];
		try {
			for await (const change of d.desired.changes({
				campIds: [lease.campId],
				signal: controller.signal,
			})) {
				if (after !== undefined && change.position <= after) current = change;
				else newer.push(change);
				if (change.position >= head) break;
			}
		} finally {
			clearTimeout(timer);
			controller.abort();
			signal.removeEventListener("abort", onAbort);
		}
		if (newer.length > 0) {
			for (const change of newer) yield await adjust(change, lease.campId);
			return;
		}
		if (redeliver && current) yield await adjust(current, lease.campId);
	}

	async function lastStatusPosition(campId: string): Promise<EventPosition> {
		let last = 0n;
		for await (const { position } of store.readAll({
			filter: { streamId: CD_STREAMS.campStatus(campId) },
		}))
			last = position;
		return asPosition(last);
	}

	async function statusSeq(stream: string): Promise<number> {
		const head = store.getStreamHead?.(stream);
		if (head) return head.revision;
		let seq = 0;
		for await (const event of store.read(stream)) seq = event.seq;
		return seq;
	}

	async function renew(
	lease: ReconcilerLease,
	): Promise<Outcome<ReconcilerLease>> {
		if (!store.renewSubscription)
			return refuse("lease-unsupported", "the event store cannot renew leases", lease.campId);
		try {
			const renewed = await store.renewSubscription({
				...subscription(lease.campId),
				holderId: leaseHolder(lease.reconcilerId, lease.holderId),
				fenceToken: lease.fence,
				leaseTtlMs: ttls.get(leaseKey(lease)) ?? CD_DEFAULTS.leaseTtlMs,
			});
			return {
				ok: true as const,
				value: Object.freeze({ ...lease, expiresAtMs: Date.parse(renewed.expiresAt) }),
			};
		} catch (error) {
			const code = codeOf(error);
			if (code === "STALE_FENCE" || code.endsWith("LEASE_CONFLICT"))
				return refuse("stale-fence", `lease fence ${lease.fence} on ${lease.campId} is no longer current`, lease.campId);
			return refuse("store-unavailable", messageOf(error), lease.campId);
		}
	}

	return Object.freeze({
		async claim(input) {
			if (!store.claimSubscription)
				return refuse("lease-unsupported", "the event store has no subscription leases", input.campId);
			try {
				const lease = await store.claimSubscription({
					...subscription(input.campId),
					holderId: leaseHolder(input.reconcilerId, input.holderId),
					leaseTtlMs: input.ttlMs,
				});
				const out: ReconcilerLease = Object.freeze({
					reconcilerId: input.reconcilerId,
					campId: input.campId,
					holderId: input.holderId,
					fence: asFence(lease.fenceToken),
					expiresAtMs: Date.parse(lease.expiresAt),
				});
				ttls.set(leaseKey(out), input.ttlMs);
				return { ok: true as const, value: out };
			} catch (error) {
				const code = codeOf(error);
				if (code === "STALE_FENCE" || code.endsWith("LEASE_CONFLICT"))
					return refuse("lease-held", `Camp ${input.campId} is leased by another reconciler`, input.campId);
				return refuse("store-unavailable", messageOf(error), input.campId);
			}
		},
		renew,
		async release(lease) {
			ttls.delete(leaseKey(lease));
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
		},
		feed,
		async resolved(lease, set: SetRecord) {
			if (set.campId !== lease.campId)
				return refuse("resolved-set-mismatch", `Set ${set.setId} belongs to Camp ${set.campId}, not ${lease.campId}`, set.setId);
			try {
				const resolved = await d.desired.resolved(set);
				if (resolved.contentHash !== set.contentHash)
					return refuse("resolved-set-mismatch", `resolved set ${resolved.contentHash} does not match Set content ${set.contentHash}`, set.setId);
				return { ok: true as const, value: resolved };
			} catch (error) {
				const message = messageOf(error);
				return refuse(
					/digest-mismatch|corrupt/u.test(message) ? "resolved-set-mismatch" : "resolved-set-missing",
					`resolved set ${set.resolvedSetDigest} for Set ${set.setId}: ${message}`,
					set.setId,
				);
			}
		},
		async report(lease, observation): Promise<Outcome<EventPosition>> {
			if (
				observation.campId !== lease.campId ||
				observation.reconcilerId !== lease.reconcilerId ||
				observation.fenceToken !== lease.fence.toString(10)
			)
				return refuse("invalid-observation", "observation is not stamped with this lease", lease.campId);
			const current = await renew(lease);
			if (!current.ok) return current;
			const stream = CD_STREAMS.campStatus(lease.campId);
			const body = stableJson(observationJson(observation));
			const prefix = `${lease.campId}:${lease.fence}:${createHash("sha256").update(body).digest("hex").slice(0, 32)}`;
			const events = [...statusEventsFor(observation, prefix)];
			for (let attempt = 0; attempt < 3; attempt += 1) {
				try {
					const result = await store.append(stream, events, {
						expectedSeq: await statusSeq(stream),
						actor: principalFor(lease.reconcilerId),
						tenant: d.tenant,
						fenceToken: lease.fence,
					});
					return {
						ok: true as const,
						value: result.lastPosition ?? (await lastStatusPosition(lease.campId)),
					};
				} catch (error) {
					const code = codeOf(error);
					if (code === "OPTIMISTIC_SEQUENCE_CONFLICT") continue;
					if (code === "STALE_FENCE" || code === "MISSING_FENCE")
						return refuse("stale-fence", `status append refused for fence ${lease.fence}`, lease.campId);
					return refuse("store-unavailable", messageOf(error), lease.campId);
				}
			}
			return refuse("report-refused", "status stream kept changing under a single-writer lease", lease.campId);
		},
		async checkpoint(lease, position) {
			if (!store.commitCheckpoint)
				return refuse("lease-unsupported", "the event store cannot commit checkpoints", lease.campId);
			try {
				const committed = await store.commitCheckpoint({
					...subscription(lease.campId),
					position,
					fenceToken: lease.fence,
				});
				return { ok: true as const, value: committed.position };
			} catch (error) {
				const code = codeOf(error);
				if (code === "CHECKPOINT_REGRESSION")
					return refuse("checkpoint-regression", `checkpoint ${position} is behind the committed one`, lease.campId);
				if (code === "STALE_FENCE")
					return refuse("stale-fence", `checkpoint refused for fence ${lease.fence}`, lease.campId);
				return refuse("store-unavailable", messageOf(error), lease.campId);
			}
		},
	} satisfies ReconcilerTransport);
}

