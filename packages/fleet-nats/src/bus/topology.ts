/**
 * The streams and buckets of §6.7, as JetStream stream configurations, and
 * their idempotent creation. Buckets are created as the key-value streams
 * the KV clients read (`KV_<bucket>`, subjects `$KV.<bucket>.>`), so their
 * limits are stated here once, beside the streams'.
 */
import {
	DiscardPolicy,
	type JetStreamManager,
	RetentionPolicy,
	StorageType,
	type StreamConfig,
} from "@nats-io/jetstream";
import { AUDIT_SUBJECTS, BUCKETS, bucketStream, STREAMS } from "./names.js";

const SECOND_NS = 1_000_000_000;
const MINUTE_NS = 60 * SECOND_NS;
const HOUR_NS = 60 * MINUTE_NS;
const DAY_NS = 24 * HOUR_NS;

export type StreamSpec = Readonly<
	Pick<StreamConfig, "name" | "subjects"> & Partial<StreamConfig>
>;

function bucket(
	name: (typeof BUCKETS)[keyof typeof BUCKETS],
	history: number,
	ttlNs: number,
	extra: Partial<StreamConfig> = {},
): StreamSpec {
	return {
		name: bucketStream(name),
		subjects: [`$KV.${name}.>`],
		max_msgs_per_subject: history,
		max_age: ttlNs,
		discard: DiscardPolicy.New,
		allow_rollup_hdrs: true,
		deny_delete: true,
		allow_direct: true,
		...extra,
	};
}

/** Every stream and bucket of one tenant account, with `replicas` copies each. */
export function topologySpecs(replicas: 1 | 3): readonly StreamSpec[] {
	const specs: StreamSpec[] = [
		bucket(BUCKETS.registry, 5, 0),
		bucket(BUCKETS.views, 1, 120 * SECOND_NS),
		bucket(BUCKETS.observations, 1, 60 * SECOND_NS),
		bucket(BUCKETS.replay, 1, 5 * MINUTE_NS, {
			allow_msg_ttl: true,
			subject_delete_marker_ttl: 60 * SECOND_NS,
		}),
		{
			name: STREAMS.submissions,
			subjects: ["fleet.submission.*"],
			max_age: DAY_NS,
		},
		{
			name: STREAMS.offers,
			subjects: ["fleet.offer.*"],
			max_age: 15 * MINUTE_NS,
		},
		{
			name: STREAMS.claims,
			subjects: ["fleet.claim.*.*"],
			max_age: 120 * SECOND_NS,
			max_msgs_per_subject: 1,
			discard: DiscardPolicy.New,
			discard_new_per_subject: true,
			deny_purge: true,
			allow_rollup_hdrs: false,
			allow_direct: true,
		},
		{
			name: STREAMS.orders,
			subjects: ["fleet.order.*"],
			max_age: 15 * MINUTE_NS,
		},
		{
			name: STREAMS.events,
			subjects: ["fleet.event.*.*"],
			max_age: 30 * DAY_NS,
			deny_delete: true,
			deny_purge: true,
		},
		{ name: STREAMS.control, subjects: ["fleet.control.*"], max_age: HOUR_NS },
		{
			name: STREAMS.journal,
			subjects: ["fleet.journal.*"],
			max_age: 0,
			deny_delete: true,
			deny_purge: true,
		},
		{
			name: STREAMS.audit,
			subjects: Object.values(AUDIT_SUBJECTS),
			max_age: 0,
			deny_delete: true,
			deny_purge: true,
		},
	];
	return specs.map((spec) => ({
		retention: RetentionPolicy.Limits,
		storage: StorageType.File,
		num_replicas: replicas,
		allow_rollup_hdrs: false,
		allow_direct: true,
		...spec,
	}));
}

/** Creates each stream, or brings an existing one to its configuration. */
export async function applyTopology(
	manager: JetStreamManager,
	replicas: 1 | 3,
): Promise<void> {
	for (const config of topologySpecs(replicas)) {
		const existing = await manager.streams
			.info(config.name)
			.catch(() => undefined);
		if (existing === undefined) await manager.streams.add(config);
		else await manager.streams.update(config.name, config);
	}
}
