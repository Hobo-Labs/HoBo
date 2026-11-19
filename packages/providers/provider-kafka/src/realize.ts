import { MESSAGING_WIT_INTERFACE, MessagingCapabilityError } from "@hobo/core";

import { isJsonObject, isJsonString, type JsonValue } from "./json.js";
import { parseKafkaClusterSpec, parseKafkaTopicResource } from "./parse.js";
import type {
	KafkaClusterSpec,
	KafkaRealizeResult,
	KafkaTopicResource,
} from "./types.js";

export interface RealizeKafkaInput {
	readonly cluster: JsonValue;
	readonly topics?: readonly JsonValue[];
}

/**
 * Matching / Resource Definition realization: plan Kafka cluster + topics.
 * Emits IaC hints; actual cloud resources go through the Camp's IacProvider.
 * Credentials remain binding refs only.
 */
export function realizeKafkaResources(
	input: RealizeKafkaInput,
): KafkaRealizeResult {
	const cluster = parseKafkaClusterSpec(input.cluster);
	const topics: KafkaTopicResource[] = (input.topics ?? []).map((t) => {
		const topic = isJsonObject(t) ? t : {};
		return parseKafkaTopicResource({
			...topic,
			cluster: isJsonString(topic.cluster) ? topic.cluster : cluster.name,
			tenantId: isJsonString(topic.tenantId)
				? topic.tenantId
				: isJsonString(topic.tenant_id)
					? topic.tenant_id
					: cluster.tenantId,
		});
	});
	if (topics.some((topic) => topic.deadLetterTopic !== undefined))
		throw new MessagingCapabilityError(
			"Kafka realization cannot bind a dead-letter transfer",
		);

	const iacHints = [
		`kafka.cluster:${cluster.kind}:${cluster.name}`,
		...topics.map(
			(t) =>
				`kafka.topic:${t.name}:partitions=${t.partitions}:rf=${t.replicationFactor}`,
		),
		`credential.binding:${cluster.credentialBindingRef}`,
	];

	return Object.freeze({
		cluster,
		topics,
		messagingBackend: "native-kafka",
		witExports: [MESSAGING_WIT_INTERFACE, "hobo:queue/queue@0.1.0"],
		iacHints,
		secretless: true as const,
	});
}

export function localRedpandaCluster(
	tenantId: string,
	name = "local-redpanda",
): KafkaClusterSpec {
	return parseKafkaClusterSpec({
		name,
		tenantId,
		kind: "local-emulator",
		bootstrapServers: ["localhost:9092"],
		credentialBindingRef: "fromBinding:local-redpanda",
		transactional: true,
		idempotentProducer: true,
		schemaRegistryRef: "local://schema-registry",
	});
}
