import type { ProfileImplementation } from "@hobo/capability-profiles";

import { KvRedisCompatibleError } from "./errors.js";

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
