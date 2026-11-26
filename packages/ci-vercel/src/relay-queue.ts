/**
 * The stateless relay's queue messages and topics (ADR-0179 §3).
 *
 * Three topics, each consumed by its own function (`vercel.json`):
 *
 * - `hobo-ci`: repair ticks, from the 15-minute schedule (`hobo-ci-repair`).
 *   The backstop: a scan of every in-flight lease.
 * - `hobo-ci-intake`: verified GitHub deliveries, in place of an inbox. The
 *   idempotency key is the GitHub delivery id; GitHub is acknowledged only
 *   after the send.
 * - `hobo-ci-lease-steps`: one delayed message per lease step, idempotency
 *   key `${leaseId}:${step}:${n}`, in place of scanning every lease.
 *
 * The records are `HostedQueueDelivery` and `HostedLeaseStep` in
 * `data-models/queue.proto` (protobuf JSON on the wire, implicit fields
 * included), constrained by `data-models/queue.cue`. `parseRelayQueueMessage`
 * is the one way in: it parses the wire value into the derived
 * `RelayQueueMessage`, so nothing downstream re-checks a field.
 */
import { create, fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import { type Job, JobSchema, type Lease } from "@hobo/ci";
import type { HostedLeaseStepKind } from "@hobo/ci-gh-actions";
import { z } from "zod";
import {
	HostedLeaseStepJobSchema,
	HostedLeaseStepSchema,
	HostedQueueDeliverySchema,
} from "./_generated/queue_pb.js";

export const RELAY_QUEUE_TOPICS = Object.freeze({
	/** Repair ticks; the schedule publishes here. */
	repair: "hobo-ci",
	/** Verified webhook deliveries. */
	intake: "hobo-ci-intake",
	/** Delayed per-lease lifecycle steps. */
	steps: "hobo-ci-lease-steps",
} as const);
export type RelayQueueTopic =
	(typeof RELAY_QUEUE_TOPICS)[keyof typeof RELAY_QUEUE_TOPICS];

/** What a send asks of the queue. */
export type RelayQueueSendOptions = Readonly<{
	idempotencyKey?: string;
	delaySeconds?: number;
	retentionSeconds?: number;
}>;
/** The queue as the relay uses it: send only. */
export type RelayQueueSend = (
	topic: RelayQueueTopic,
	payload: JsonValue,
	options: RelayQueueSendOptions,
) => Promise<void>;

/** A verified delivery, as intake hands it to the queue and the consumer gets it back. */
export type RelayQueuedDelivery = Readonly<{
	deliveryId: string;
	event: "workflow_job" | "workflow_run";
	installationId: number;
	repositoryId: number;
	rawBody: Uint8Array;
	receivedAt: string;
}>;

/** One lease step: the lease, the step, its rung on the ladder, and the job (for a rebuild). */
export type RelayQueuedStep = Readonly<{
	leaseId: string;
	step: HostedLeaseStepKind;
	n: number;
	job: Job;
}>;

// domain-view: the parsed form of the queue records in data-models/queue.proto.
export type RelayQueueMessage =
	| Readonly<{ kind: "delivery"; delivery: RelayQueuedDelivery }>
	| Readonly<{ kind: "lease-step"; step: RelayQueuedStep }>
	| Readonly<{
			kind: "repair";
			source: "static" | "hobo-ci";
			/** Published by a platform schedule (it carries the schedule's identity). */
			platformSchedule: boolean;
	  }>
	/** A wakeup for a delivery in a pre-4b relay's inbox: there is no inbox here. */
	| Readonly<{ kind: "wakeup"; deliveryId: string }>
	/** `null`: an authenticated manual tick. */
	| Readonly<{ kind: "manual" }>;

const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/u;
const LEASE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
/** The relay accepts webhook bodies up to 1 MiB (`http-handler.ts`). */
export const MAX_DELIVERY_BODY_BYTES = 1024 * 1024;
const STEP_KINDS = new Set<string>([
	"dispatch-check",
	"claim-timeout",
	"reconcile",
]);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

/** Raised for a queue message that is not one of ours. Says which kind, never content. */
export class RelayQueueMessageError extends Error {
	constructor(kind: string) {
		super(`invalid relay queue message: ${kind}`);
		this.name = "RelayQueueMessageError";
	}
}

const Tagged = z.object({ kind: z.enum(["delivery", "lease-step"]) });
const Repair = z.object({
	source: z.enum(["static", "hobo-ci"]),
	name: z.literal("hobo-ci-repair"),
});
/** Untagged messages: what pre-4b relays and the platform schedule send. */
const Untagged = z.record(z.string(), z.json());
const Wakeup = z.object({ deliveryId: z.string().regex(DELIVERY_ID) });

function isStepKind(value: string): value is HostedLeaseStepKind {
	return STEP_KINDS.has(value);
}

/** Parse what a queue delivered (or the wakeup handoff carried). Throws for anything else. */
export function parseRelayQueueMessage(value: JsonValue): RelayQueueMessage {
	if (value === null) return { kind: "manual" };
	const tagged = Tagged.safeParse(value);
	if (tagged.success) {
		const json = value;
		if (tagged.data.kind === "delivery") {
			let record: ReturnType<typeof create<typeof HostedQueueDeliverySchema>>;
			try {
				record = fromJson(HostedQueueDeliverySchema, json);
			} catch {
				throw new RelayQueueMessageError("delivery");
			}
			if (
				!DELIVERY_ID.test(record.deliveryId) ||
				(record.event !== "workflow_job" && record.event !== "workflow_run") ||
				!positive(record.installationId) ||
				!positive(record.repositoryId) ||
				record.rawBody.byteLength === 0 ||
				record.rawBody.byteLength > MAX_DELIVERY_BODY_BYTES ||
				!Number.isFinite(Date.parse(record.receivedAt))
			)
				throw new RelayQueueMessageError("delivery");
			return {
				kind: "delivery",
				delivery: Object.freeze({
					deliveryId: record.deliveryId,
					event: record.event,
					installationId: record.installationId,
					repositoryId: record.repositoryId,
					rawBody: record.rawBody,
					receivedAt: record.receivedAt,
				}),
			};
		}
		let step: ReturnType<typeof create<typeof HostedLeaseStepSchema>>;
		try {
			step = fromJson(HostedLeaseStepSchema, json);
		} catch {
			throw new RelayQueueMessageError("lease-step");
		}
		const job = step.job;
		if (
			!LEASE_ID.test(step.leaseId) ||
			!isStepKind(step.step) ||
			step.n > 64 ||
			!job ||
			!positive(job.id) ||
			!positive(job.runId) ||
			!positive(job.runAttempt) ||
			!positive(job.repositoryId) ||
			!positive(job.installationId) ||
			!REPOSITORY.test(job.repository)
		)
			throw new RelayQueueMessageError("lease-step");
		return {
			kind: "lease-step",
			step: Object.freeze({
				leaseId: step.leaseId,
				step: step.step,
				n: step.n,
				job: create(JobSchema, {
					id: job.id,
					runId: job.runId,
					runAttempt: job.runAttempt,
					repositoryId: job.repositoryId,
					installationId: job.installationId,
					repository: job.repository,
					isolatedRequired: job.isolatedRequired,
					action: "queued",
				}),
			}),
		};
	}
	const untagged = Untagged.safeParse(value);
	if (!untagged.success) throw new RelayQueueMessageError("unknown");
	const fields = untagged.data;
	if ("deliveryId" in fields) {
		if ("source" in fields || "name" in fields)
			throw new RelayQueueMessageError("ambiguous");
		const wakeup = Wakeup.safeParse(fields);
		if (!wakeup.success) throw new RelayQueueMessageError("wakeup");
		return { kind: "wakeup", deliveryId: wakeup.data.deliveryId };
	}
	const repair = Repair.safeParse(fields);
	if (!repair.success) throw new RelayQueueMessageError("unknown");
	return {
		kind: "repair",
		source: repair.data.source,
		platformSchedule: "scheduleId" in fields,
	};
}

/** The wire form of a parsed message: what a send or the wakeup handoff carries. */
export function encodeRelayQueueMessage(message: RelayQueueMessage): JsonValue {
	switch (message.kind) {
		case "delivery":
			return toJson(
				HostedQueueDeliverySchema,
				create(HostedQueueDeliverySchema, {
					kind: "delivery",
					...message.delivery,
				}),
				{ alwaysEmitImplicit: true },
			);
		case "lease-step":
			return toJson(
				HostedLeaseStepSchema,
				create(HostedLeaseStepSchema, {
					kind: "lease-step",
					leaseId: message.step.leaseId,
					step: message.step.step,
					n: message.step.n,
					job: create(HostedLeaseStepJobSchema, {
						id: message.step.job.id,
						runId: message.step.job.runId,
						runAttempt: message.step.job.runAttempt,
						repositoryId: message.step.job.repositoryId,
						installationId: message.step.job.installationId,
						repository: message.step.job.repository,
						isolatedRequired: message.step.job.isolatedRequired,
					}),
				}),
				{ alwaysEmitImplicit: true },
			);
		case "repair":
			return { source: message.source, name: "hobo-ci-repair" };
		case "wakeup":
			return { deliveryId: message.deliveryId };
		case "manual":
			return null;
	}
}

/** Deliveries stay queued up to the queue's limit; dedupe covers the first 24 h. */
const DELIVERY_RETENTION_SECONDS = 7 * 24 * 60 * 60;

/** Send one verified delivery to the intake topic, keyed by its GitHub delivery id. */
export function sendDelivery(
	send: RelayQueueSend,
	delivery: RelayQueuedDelivery,
): Promise<void> {
	return send(
		RELAY_QUEUE_TOPICS.intake,
		encodeRelayQueueMessage({ kind: "delivery", delivery }),
		{
			idempotencyKey: delivery.deliveryId,
			retentionSeconds: DELIVERY_RETENTION_SECONDS,
		},
	);
}

/**
 * When each step of a chain is due, in minutes after the lease was created.
 * Rung `n` of any chain is due at `createdAt + LADDER[n]`, so two chains of
 * one lease and step land on the same keys and the queue keeps one. Past the
 * last rung the 15-minute repair tick takes over.
 */
export const LEASE_STEP_LADDER_MINUTES: readonly number[] = Object.freeze([
	1, 2.5, 5, 10, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1080, 1440,
]);

/** Which step chain a lease in this state belongs to; none once it has ended. */
export function leaseStepKind(state: string): HostedLeaseStepKind | undefined {
	switch (state) {
		case "reserved":
		case "dispatching":
			return "dispatch-check";
		case "dispatched":
		case "claiming":
			return "claim-timeout";
		case "running":
		case "uncertain":
			return "reconcile";
		default:
			return undefined;
	}
}

/** The first rung at or after `fromN` that is due after `afterMs`. */
export function nextLeaseStepRung(
	createdAt: string,
	afterMs: number,
	fromN = 0,
): { n: number; dueMs: number } | undefined {
	const anchor = Date.parse(createdAt);
	if (!Number.isFinite(anchor)) return undefined;
	for (let n = fromN; n < LEASE_STEP_LADDER_MINUTES.length; n++) {
		const dueMs = anchor + (LEASE_STEP_LADDER_MINUTES[n] ?? 0) * 60_000;
		if (dueMs > afterMs) return { n, dueMs };
	}
	return undefined;
}

const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;

/**
 * Schedules lease steps as delayed queue messages.
 *
 * `changed` is the cache store's `onLeaseChange` hook: a lease entering a
 * new step chain (reserved, dispatched, running or uncertain, from another
 * chain or from nothing) gets that chain's next rung. `next` continues a
 * chain from a step that just ran.
 */
export function createLeaseStepScheduler(
	options: Readonly<{ send: RelayQueueSend; now?: () => number }>,
) {
	const now = options.now ?? Date.now;
	async function schedule(
		lease: Lease,
		kind: HostedLeaseStepKind,
		fromN: number,
	): Promise<boolean> {
		const at = now();
		const rung = nextLeaseStepRung(lease.createdAt, at, fromN);
		if (!rung) return false;
		const delaySeconds = Math.min(
			MAX_DELAY_SECONDS,
			Math.max(0, Math.ceil((rung.dueMs - at) / 1000)),
		);
		const step: RelayQueuedStep = {
			leaseId: lease.id,
			step: kind,
			n: rung.n,
			job: create(JobSchema, {
				id: lease.jobId,
				runId: lease.originalRunId,
				runAttempt: lease.runAttempt,
				repositoryId: lease.repositoryId,
				installationId: lease.installationId,
				repository: lease.repository,
				isolatedRequired: !!lease.sandboxPricing || !!lease.sandboxName,
			}),
		};
		await options.send(
			RELAY_QUEUE_TOPICS.steps,
			encodeRelayQueueMessage({ kind: "lease-step", step }),
			{
				idempotencyKey: `${lease.id}:${kind}:${rung.n}`,
				delaySeconds,
				// Retention must cover the delay; a day past it is plenty.
				retentionSeconds: Math.min(MAX_DELAY_SECONDS, delaySeconds + 86_400),
			},
		);
		return true;
	}
	return {
		/** The store's `onLeaseChange`: start the chain a lease just entered. */
		async changed(change: {
			lease: Lease;
			previousState: string | undefined;
		}): Promise<void> {
			const kind = leaseStepKind(change.lease.state);
			if (!kind) return;
			if (
				change.previousState !== undefined &&
				leaseStepKind(change.previousState) === kind
			)
				return;
			await schedule(change.lease, kind, 0);
		},
		/** Continue a chain after rung `n` ran; false past the ladder's end. */
		next(lease: Lease, kind: HostedLeaseStepKind, n: number): Promise<boolean> {
			return schedule(lease, kind, n + 1);
		},
	};
}
export type LeaseStepScheduler = ReturnType<typeof createLeaseStepScheduler>;
