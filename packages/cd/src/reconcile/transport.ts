import { createHash } from "node:crypto";
import {
	type DurableEventStore,
	type EventPosition,
	EventStoreError,
	type FenceToken,
	type PrincipalRef,
} from "@hobo/core";
import { CampManagement, type SetRecord } from "../_generated/cd_pb.js";
import {
	CD_DEFAULTS,
	CD_EVENTS,
	CD_STREAMS,
	CD_SUBSCRIPTIONS,
} from "../events.js";
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
import { refuse } from "./errors.js";
import { stableJson } from "./json.js";
import { observationJson, statusEventsFor } from "./status-events.js";

export type InProcessTransportDeps = CdBase & {
	readonly desired: DesiredStateReader;
	readonly posture?: PostureService;
	readonly topology?: TopologyReader;
	readonly feedTimeoutMs?: number;
};

const CHANGE_TYPES: ReadonlySet<string> = new Set([
	CD_EVENTS.SetCreated,
	CD_EVENTS.PolicyBindingChanged,
	CD_EVENTS.CampManagementChanged,
]);

export function leaseHolder(reconcilerId: string, holderId: string): string {
	return `${reconcilerId}/${holderId}`;
}

function principalFor(reconcilerId: string): PrincipalRef {
	return { kind: "service", id: `cd-reconciler:${reconcilerId}` };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: JavaScript catch values are untrusted; only EventStoreError codes are read.
function codeOf(error: unknown): string {
	try {
		return error instanceof EventStoreError ? String(error.code) : "";
	} catch {
		return "";
	}
}

const MISMATCH_CODES: ReadonlySet<string> = new Set([
	"resolved-set-digest-mismatch",
	"resolved-set-mismatch",
	"blob-digest-mismatch",
	"artifact-corrupt",
	"artifact-digest-mismatch",
]);

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: JavaScript catch values are untrusted; only an Error's `code` property is read and matched against MISMATCH_CODES.
function typedCodeOf(error: unknown): string {
	try {
		return error instanceof Error && "code" in error ? String(error.code) : "";
	} catch {
		return "";
	}
}

function asPosition(value: bigint): EventPosition {
	return value as EventPosition;
}

function asFence(value: bigint): FenceToken {
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

	async function adjust(
		change: DesiredStateChange,
		campId: CampId,
	): Promise<DesiredStateChange> {
		const observeFields = d.posture
			? await d.posture.observeFields(campId)
			: change.observeFields;
		const topology = d.topology ? await d.topology.camp(campId) : undefined;
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
			return refuse(
				"lease-unsupported",
				"the event store cannot renew leases",
				lease.campId,
			);
		try {
			const renewed = await store.renewSubscription({
				...subscription(lease.campId),
				holderId: leaseHolder(lease.reconcilerId, lease.holderId),
				fenceToken: lease.fence,
				leaseTtlMs: ttls.get(leaseKey(lease)) ?? CD_DEFAULTS.leaseTtlMs,
			});
			return {
				ok: true as const,
				value: Object.freeze({
					...lease,
					expiresAtMs: Date.parse(renewed.expiresAt),
				}),
			};
		} catch (error) {
			const code = codeOf(error);
			if (code === "STALE_FENCE" || code.endsWith("LEASE_CONFLICT"))
				return refuse(
					"stale-fence",
					`lease fence ${lease.fence} on ${lease.campId} is no longer current`,
					lease.campId,
				);
			return refuse(
				"store-unavailable",
				"The CD journal is unavailable.",
				lease.campId,
			);
		}
	}

	return Object.freeze({
		async claim(input) {
			if (!store.claimSubscription)
				return refuse(
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
					return refuse(
						"lease-held",
						`Camp ${input.campId} is leased by another reconciler`,
						input.campId,
					);
				return refuse(
					"store-unavailable",
					"The CD journal is unavailable.",
					input.campId,
				);
			}
		},
		renew,
		async release(lease) {
			ttls.delete(leaseKey(lease));
			delivered.delete(leaseKey(lease));
			if (!store.releaseSubscription) return;
			try {
				await store.releaseSubscription({
					...subscription(lease.campId),
					holderId: leaseHolder(lease.reconcilerId, lease.holderId),
					fenceToken: lease.fence,
				});
			} catch {}
		},
		feed,
		async resolved(lease, set: SetRecord) {
			if (set.campId !== lease.campId)
				return refuse(
					"resolved-set-mismatch",
					`Set ${set.setId} belongs to Camp ${set.campId}, not ${lease.campId}`,
					set.setId,
				);
			try {
				const resolved = await d.desired.resolved(set);
				if (resolved.contentHash !== set.contentHash)
					return refuse(
						"resolved-set-mismatch",
						`resolved set ${resolved.contentHash} does not match Set content ${set.contentHash}`,
						set.setId,
					);
				return { ok: true as const, value: resolved };
			} catch (error) {
				return refuse(
					MISMATCH_CODES.has(typedCodeOf(error))
						? "resolved-set-mismatch"
						: "resolved-set-missing",
					"The resolved set could not be loaded or verified.",
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
				return refuse(
					"invalid-observation",
					"observation is not stamped with this lease",
					lease.campId,
				);
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
						value:
							result.lastPosition ?? (await lastStatusPosition(lease.campId)),
					};
				} catch (error) {
					const code = codeOf(error);
					if (code === "OPTIMISTIC_SEQUENCE_CONFLICT") continue;
					if (code === "STALE_FENCE" || code === "MISSING_FENCE")
						return refuse(
							"stale-fence",
							`status append refused for fence ${lease.fence}`,
							lease.campId,
						);
					return refuse(
						"store-unavailable",
						"The CD journal is unavailable.",
						lease.campId,
					);
				}
			}
			return refuse(
				"report-refused",
				"status stream kept changing under a single-writer lease",
				lease.campId,
			);
		},
		async checkpoint(lease, position) {
			if (!store.commitCheckpoint)
				return refuse(
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
				return { ok: true as const, value: committed.position };
			} catch (error) {
				const code = codeOf(error);
				if (code === "CHECKPOINT_REGRESSION")
					return refuse(
						"checkpoint-regression",
						`checkpoint ${position} is behind the committed one`,
						lease.campId,
					);
				if (code === "STALE_FENCE")
					return refuse(
						"stale-fence",
						`checkpoint refused for fence ${lease.fence}`,
						lease.campId,
					);
				return refuse(
					"store-unavailable",
					"The CD journal is unavailable.",
					lease.campId,
				);
			}
		},
	} satisfies ReconcilerTransport);
}
