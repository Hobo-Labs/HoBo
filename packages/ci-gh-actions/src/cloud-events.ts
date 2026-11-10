/**
 * Infrastructure events from the relay and the box worker as CloudEvents.
 *
 * A log line is for a person reading it later. These are for a program
 * reacting now: page on a relay that cannot start, open an incident when the
 * worker force-cancels a run, count jobs taken per node. They follow the
 * platform's boundary rule (ADR-0046): a native event envelope inside,
 * CloudEvents 1.0 at the edge, mapped by `@hobo/core`.
 *
 * Only named facts are emitted. Each has a past-tense `ci.*` type below; a
 * log event with no entry stays a log line. Events are delivered over the
 * CloudEvents HTTP binding in batched structured mode
 * (`application/cloudevents-batch+json`), which any CloudEvents receiver
 * accepts. Delivery is best effort: a bounded queue, no retry, and never a
 * reason for the relay to slow down.
 */
import { randomUUID } from "node:crypto";
import { type CloudEvent, toCloudEvent } from "@hobo/core";

/** Log event name to CloudEvents type. Past-tense facts, one per thing that happened. */
export const CI_INFRA_EVENT_TYPES: ReadonlyMap<string, string> = new Map([
	// Hosted relay
	["hobo_ci_relay_init_failed", "ci.RelayStartFailed"],
	["hobo_ci_relay_request_failed", "ci.RelayRequestFailed"],
	["hobo_ci_webhook_ingest_failed", "ci.WebhookIngestFailed"],
	["hobo_ci_control_failed", "ci.ControlRequestFailed"],
	["hobo_ci_ready_check_failed", "ci.ReadinessCheckFailed"],
	// Worker lifecycle
	["hobo_ci_isolated_worker_started", "ci.WorkerStarted"],
	["hobo_ci_isolated_worker_draining", "ci.WorkerDrainStarted"],
	["hobo_ci_isolated_worker_drained", "ci.WorkerDrained"],
	["hobo_ci_isolated_worker_drain_timeout", "ci.WorkerDrainTimedOut"],
	["hobo_ci_isolated_worker_tick_failed", "ci.WorkerTickFailed"],
	// Jobs and runners
	["hobo_ci_job_pickup", "ci.JobPickedUp"],
	["hobo_ci_launch_failed", "ci.RunnerLaunchFailed"],
	["hobo_ci_launch_yielded_foreign_runner", "ci.RunnerLaunchYieldedForeign"],
	["hobo_ci_jit_empty_exit", "ci.JitRunnerExitedWithoutJob"],
	["hobo_ci_jit_empty_exit_backoff", "ci.JitEmptyExitBackoff"],
	["hobo_ci_container_oom", "ci.ContainerOomKilled"],
	["hobo_ci_container_timeout_enforced", "ci.ContainerTimedOut"],
	// Runs the worker interfered with
	["hobo_ci_orphan_job_confirmed", "ci.OrphanJobConfirmed"],
	["hobo_ci_orphan_runner_delete", "ci.OrphanRunnerDeleted"],
	["hobo_ci_orphan_run_force_cancel", "ci.RunForceCancelled"],
	["hobo_ci_orphan_run_rerun", "ci.RunRerunRequested"],
	// Host pressure
	["hobo_ci_inode_pressure", "ci.HostInodePressureDetected"],
	["hobo_ci_memory_admission_wait", "ci.MemoryAdmissionDelayed"],
	["hobo_ci_storage_admission_wait", "ci.StorageAdmissionDelayed"],
	// Relay mesh
	["hobo_ci_mesh_job_taken", "ci.MeshJobTaken"],
	["hobo_ci_mesh_board_unreachable", "ci.MeshBoardLost"],
	["hobo_ci_mesh_board_recovered", "ci.MeshBoardRecovered"],
	["hobo_ci_mesh_claims_unreachable", "ci.MeshClaimsLost"],
	["hobo_ci_mesh_claims_recovered", "ci.MeshClaimsRecovered"],
	// Mesh capacity and availability
	["hobo_ci_mesh_node_joined", "ci.MeshNodeJoined"],
	["hobo_ci_mesh_node_lost", "ci.MeshNodeLost"],
	["hobo_ci_mesh_node_unhealthy", "ci.MeshNodeDegraded"],
	["hobo_ci_mesh_node_recovered", "ci.MeshNodeRecovered"],
	["hobo_ci_mesh_capacity_exhausted", "ci.MeshCapacityExhausted"],
	["hobo_ci_mesh_capacity_restored", "ci.MeshCapacityRestored"],
	["hobo_ci_mesh_capacity", "ci.MeshCapacityReported"],
	["hobo_ci_mesh_config_published", "ci.MeshConfigPublished"],
	["hobo_ci_mesh_config_drift", "ci.MeshConfigDrifted"],
	// Telemetry about telemetry
	["hobo_ci_trace_export_problem", "ci.TraceExportDegraded"],
]);

export type CiEventFields = Readonly<Record<string, string | number | boolean>>;

/** Where this process's events come from. */
export type CiEventSource = Readonly<{
	/** The account or deployment the events belong to; the CloudEvents source authority. */
	tenant: string;
	/** One ordered stream per process start, e.g. `ci-worker/<host>/<boot>`. */
	streamId: string;
	/** The service principal named as the actor. */
	actorId: string;
}>;

/**
 * The CloudEvent for one named log event, or `undefined` when the name is
 * not an infrastructure fact. A `runId` field becomes the correlation id, so
 * a consumer can group everything about one workflow run.
 */
export function toCiCloudEvent(input: {
	name: string;
	fields: CiEventFields;
	source: CiEventSource;
	seq: number;
	id: string;
	time: string;
}): CloudEvent | undefined {
	const type = CI_INFRA_EVENT_TYPES.get(input.name);
	if (type === undefined) return undefined;
	const runId = Number.isSafeInteger(input.fields.runId)
		? `github-actions-run:${input.fields.runId}`
		: undefined;
	const base = {
		id: input.id,
		type,
		v: 1,
		streamId: input.source.streamId,
		seq: input.seq,
		ts: input.time,
		actor: { kind: "service", id: input.source.actorId },
		tenant: input.source.tenant,
		data: { ...input.fields },
	};
	// `toCloudEvent` parses the envelope before mapping it, so a malformed
	// event fails here and not at the receiver.
	return toCloudEvent(
		runId === undefined ? base : { ...base, correlationId: runId },
	);
}

/** Receives a batch of CloudEvents. */
export type CiEventSink = (events: readonly CloudEvent[]) => Promise<void>;

export function createCiEventEmitter(options: {
	source: CiEventSource;
	/** No sink disables emission: every call is a no-op. */
	sink: CiEventSink | undefined;
	now?: () => number;
	id?: () => string;
	flushIntervalMs?: number;
	/** Events held while the receiver is slow; the oldest are dropped past it. */
	maxQueue?: number;
	batchSize?: number;
	/** Told about failed deliveries or dropped events, at most once a minute. */
	onProblem?: (problem: { failedDeliveries: number; dropped: number }) => void;
}) {
	const sink = options.sink;
	const now = options.now ?? Date.now;
	const id = options.id ?? randomUUID;
	const maxQueue = options.maxQueue ?? 2048;
	const batchSize = options.batchSize ?? 100;
	const queue: CloudEvent[] = [];
	let seq = 0;
	let dropped = 0;
	let failedDeliveries = 0;
	let reportedAt = 0;
	let flushing: Promise<void> | undefined;

	async function drain(deliver: CiEventSink): Promise<void> {
		while (queue.length > 0) {
			const batch = queue.splice(0, batchSize);
			try {
				await deliver(batch);
			} catch {
				// Not retried: a dead receiver must not grow the queue.
				failedDeliveries += 1;
			}
		}
		if (dropped + failedDeliveries > 0 && now() - reportedAt >= 60_000) {
			reportedAt = now();
			options.onProblem?.({ failedDeliveries, dropped });
			dropped = 0;
			failedDeliveries = 0;
		}
	}

	function flush(): Promise<void> {
		if (!sink) return Promise.resolve();
		flushing ??= drain(sink).finally(() => {
			flushing = undefined;
		});
		return flushing;
	}

	const timer = sink
		? setInterval(() => {
				void flush();
			}, options.flushIntervalMs ?? 2000)
		: undefined;
	timer?.unref();

	return {
		enabled: sink !== undefined,
		/** Queues the CloudEvent for a named log event; other names are ignored. */
		emit(name: string, fields: CiEventFields = {}): void {
			if (!sink || !CI_INFRA_EVENT_TYPES.has(name)) return;
			const event = toCiCloudEvent({
				name,
				fields,
				source: options.source,
				seq,
				id: id(),
				time: new Date(now()).toISOString(),
			});
			if (!event) return;
			seq += 1;
			queue.push(event);
			if (queue.length > maxQueue)
				dropped += queue.splice(0, queue.length - maxQueue).length;
		},
		flush,
		async close(): Promise<void> {
			if (timer) clearInterval(timer);
			await flush();
		},
	};
}

export type CiEventEmitter = ReturnType<typeof createCiEventEmitter>;

/** Delivers batches over the CloudEvents HTTP binding, batched structured mode. */
export function cloudEventsHttpSink(options: {
	url: string;
	headers?: Readonly<Record<string, string>>;
	fetch?: typeof fetch;
	timeoutMs?: number;
}): CiEventSink {
	const send = options.fetch ?? fetch;
	return async (events) => {
		const response = await send(options.url, {
			method: "POST",
			headers: {
				...options.headers,
				"Content-Type": "application/cloudevents-batch+json",
			},
			body: JSON.stringify(events),
			redirect: "error",
			signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
		});
		await response.body?.cancel();
		if (!response.ok)
			throw new Error(`CloudEvents delivery failed (${response.status})`);
	};
}

/**
 * The receiver named by `HOBO_CI_EVENTS_URL`, with `HOBO_CI_EVENTS_HEADERS`
 * (`key=value,key=value`, values percent-encoded) for its credentials.
 * `target` is the URL without credentials or query, for the startup log.
 */
export function ciEventSinkFromEnv(
	env: Readonly<Record<string, string | undefined>>,
	send?: typeof fetch,
) {
	const raw = env.HOBO_CI_EVENTS_URL?.trim() ?? "";
	let url: URL | undefined;
	try {
		url = raw ? new URL(raw) : undefined;
	} catch {
		url = undefined;
	}
	if (!url || !["http:", "https:"].includes(url.protocol))
		return { sink: undefined, target: "" };
	const headers = new Map<string, string>();
	for (const pair of (env.HOBO_CI_EVENTS_HEADERS ?? "").split(",")) {
		const at = pair.indexOf("=");
		if (at <= 0) continue;
		const value = pair.slice(at + 1).trim();
		try {
			headers.set(pair.slice(0, at).trim(), decodeURIComponent(value));
		} catch {
			headers.set(pair.slice(0, at).trim(), value);
		}
	}
	const sink: CiEventSink = cloudEventsHttpSink({
		url: url.href,
		headers: Object.fromEntries(headers),
		fetch: send ?? fetch,
	});
	return { sink, target: `${url.origin}${url.pathname}` };
}
