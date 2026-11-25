/**
 * Redis data structures are not delivery guarantees.
 *
 * Redis has lists, streams, and pub/sub, and every one of them looks like a
 * queue or a topic from a distance. None of them is one:
 *
 * - `LPUSH`/`RPOP` is a list with no acknowledgement, no redelivery, no
 *   visibility timeout, and no dead-letter path. A consumer that crashes after
 *   `RPOP` has silently dropped the message, which is the exact failure
 *   `queue.at-least-once/v1` exists to rule out.
 * - Redis pub/sub delivers to whoever is connected at the instant of publish
 *   and retains nothing, so it satisfies `topic.ephemeral-pubsub/v1` at best
 *   and never `topic.durable-log/v1`.
 * - Streams get closer, but consumer groups, offsets, and retention are their
 *   own semantics with their own failure modes, and they need their own
 *   conformance evidence.
 *
 * So the rule this module enforces is simple: evidence gathered against a
 * `kv.*` profile can never be reused as evidence for a `queue.*` or `topic.*`
 * profile. A product may implement both — it just has to prove both.
 */
import type { ProfileImplementation } from "@hobo/capability-profiles";

import { KvRedisCompatibleError } from "./errors.js";

/** Profiles that Redis-compatible semantics conspicuously do not imply. */
export const KV_REDIS_NON_IMPLIED_PROFILES = [
	"queue.at-least-once/v1",
	"queue.fifo/v1",
	"topic.pubsub/v1",
	"topic.durable-log/v1",
] as const;

export type NonImpliedProfile = (typeof KV_REDIS_NON_IMPLIED_PROFILES)[number];

interface NonImplicationRationale {
	"queue.at-least-once/v1": string;
	"queue.fifo/v1": string;
	"topic.pubsub/v1": string;
	"topic.durable-log/v1": string;
}

const RATIONALE: NonImplicationRationale = {
	"queue.at-least-once/v1":
		"A Redis list pops a message and forgets it. At-least-once needs an acknowledgement and a redelivery path, so it needs its own conformance evidence.",
	"queue.fifo/v1":
		"List order is insertion order at one key, not ordered delivery within a group across competing consumers with redelivery.",
	"topic.pubsub/v1":
		"Redis pub/sub reaches whoever is connected at publish time. Subscriber fan-out with a defined delivery contract is a separate profile.",
	"topic.durable-log/v1":
		"Nothing in the key/value surface retains published messages or addresses them by offset.",
};

export function explainNonImplication(profileId: string): string | undefined {
	switch (profileId) {
		case "queue.at-least-once/v1":
		case "queue.fifo/v1":
		case "topic.pubsub/v1":
		case "topic.durable-log/v1":
			return RATIONALE[profileId];
		default:
			return undefined;
	}
}

export function isNonImpliedProfile(
	profileId: string,
): profileId is NonImpliedProfile {
	return (
		profileId === "queue.at-least-once/v1" ||
		profileId === "queue.fifo/v1" ||
		profileId === "topic.pubsub/v1" ||
		profileId === "topic.durable-log/v1"
	);
}

const KV_PROFILE_PREFIX = "kv.";
const DELIVERY_PREFIXES = ["queue.", "topic."] as const;

function isKvProfile(profileId: string): boolean {
	return profileId.startsWith(KV_PROFILE_PREFIX);
}

function isDeliveryProfile(profileId: string): boolean {
	return DELIVERY_PREFIXES.some((prefix) => profileId.startsWith(prefix));
}

export type ImplicationViolation = {
	readonly profileId: string;
	readonly conformanceRef: string;
	readonly reason: string;
};

/**
 * Find declarations where a delivery profile is leaning on key/value evidence.
 *
 * The check is on the conformance reference, not on the profile list, because
 * a product implementing both a store and a queue is perfectly legitimate. The
 * thing that is never legitimate is one conformance run standing behind both.
 */
export function findQueueTopicImplications(
	implementsProfiles: readonly ProfileImplementation[],
): readonly ImplicationViolation[] {
	const kvConformanceRefs = new Set(
		implementsProfiles
			.filter((implementation) => isKvProfile(implementation.profileId))
			.map((implementation) => implementation.conformanceRef),
	);
	if (kvConformanceRefs.size === 0) return [];

	const violations: ImplicationViolation[] = [];
	for (const implementation of implementsProfiles) {
		if (!isDeliveryProfile(implementation.profileId)) continue;
		if (!kvConformanceRefs.has(implementation.conformanceRef)) continue;
		violations.push({
			profileId: implementation.profileId,
			conformanceRef: implementation.conformanceRef,
			reason:
				explainNonImplication(implementation.profileId) ??
				"A delivery profile cannot be substantiated by key/value conformance evidence.",
		});
	}
	return violations;
}

/**
 * Parse-boundary guard. A provider package calls this on its own declaration
 * at module load so the mistake is a build failure, not a runtime surprise
 * three layers into the planner.
 */
export function assertNoQueueTopicImplication(
	implementsProfiles: readonly ProfileImplementation[],
	subject = "this product declaration",
): void {
	const violations = findQueueTopicImplications(implementsProfiles);
	if (violations.length === 0) return;
	const detail = violations
		.map((violation) => `${violation.profileId}: ${violation.reason}`)
		.join(" ");
	throw new KvRedisCompatibleError(
		"QUEUE_TOPIC_IMPLICATION",
		`${subject} substantiates a delivery profile with key/value conformance evidence. ${detail}`,
	);
}
