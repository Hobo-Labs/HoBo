import type { DeliveryGuarantee, MessagingCapabilities } from "@hobo/core";

export type KafkaClusterKind =
	| "self-hosted"
	| "redpanda"
	| "msk"
	| "confluent"
	| "azure-event-hubs"
	| "local-emulator";

// domain-view: parse-don't-validate parsed/derived type; wire form is KafkaClusterSpec in data-models/provider_kafka.proto.
export interface KafkaClusterSpec {
	readonly name: string;
	readonly tenantId: string;
	readonly kind: KafkaClusterKind;
	readonly bootstrapServers: readonly string[];
	/** Secretless credential binding ref — never plaintext. */
	readonly credentialBindingRef: string;
	readonly transactional: boolean;
	readonly idempotentProducer: boolean;
	readonly schemaRegistryRef?: string;
	readonly labels?: Readonly<Record<string, string>>;
}

// domain-view: parse-don't-validate parsed/derived type; wire form is KafkaTopicResource in data-models/provider_kafka.proto.
export interface KafkaTopicResource {
	readonly name: string;
	readonly cluster: string;
	readonly tenantId: string;
	readonly partitions: number;
	readonly replicationFactor: number;
	readonly deliveryGuarantee: DeliveryGuarantee;
	readonly deadLetterTopic?: string;
	readonly schemaRef?: string;
}

// domain-view: parse-don't-validate parsed/derived type; wire form is KafkaResourceDefinition in data-models/provider_kafka.proto.
export interface KafkaResourceDefinition {
	readonly apiVersion: "hobo.kafka/v1";
	readonly kind: "KafkaCluster" | "KafkaTopic";
	readonly name: string;
	readonly tenantId: string;
	readonly spec: KafkaClusterSpec | KafkaTopicResource;
}

// domain-view: parse-don't-validate parsed/derived type; wire form is KafkaDoctorReport in data-models/provider_kafka.proto.
export interface KafkaDoctorReport {
	readonly redpandaAvailable: boolean;
	readonly brokersReachable: boolean;
	readonly fidelity: "simulated" | "live";
	readonly notes: readonly string[];
	readonly remediation: readonly string[];
}

export interface KafkaRealizeResult {
	readonly cluster: KafkaClusterSpec;
	readonly topics: readonly KafkaTopicResource[];
	readonly messagingBackend: "native-kafka";
	readonly witExports: readonly string[];
	readonly iacHints: readonly string[];
	readonly secretless: true;
}

export const KAFKA_MESSAGING_CAPABILITIES: MessagingCapabilities =
	Object.freeze({
		deliveryGuarantees: [
			"at-least-once",
			"exactly-once",
			"at-most-once",
		] as const satisfies readonly DeliveryGuarantee[],
		consumerGroups: true,
		transactionalProduce: true,
		idempotentProduce: true,
		schemaRegistry: true,
		deadLetter: false,
		partitionAware: true,
		crossYardFederation: true,
	});
