export { diagnoseKafkaReadiness, type KafkaDoctorInput } from "./doctor.js";
export {
	AUTH_SCHEMA,
	CAPABILITIES_SCHEMA,
	COST_SCHEMA,
	KAFKA_PROVIDER_ID,
	MANIFEST_SCHEMA,
	type PublishedManifestDocuments,
	publishCapabilityManifest,
} from "./manifest.js";
export {
	createKafkaMessaging,
	type KafkaMessaging,
	type KafkaMessagingOptions,
} from "./messaging.js";
export {
	parseKafkaClusterKind,
	parseKafkaClusterSpec,
	parseKafkaResourceDefinition,
	parseKafkaTopicResource,
} from "./parse.js";
export {
	createKafkaProvider,
	type KafkaCapabilityProvider,
	type KafkaProviderOptions,
} from "./provider.js";
export {
	localRedpandaCluster,
	type RealizeKafkaInput,
	realizeKafkaResources,
} from "./realize.js";
export {
	createInMemoryKafkaTransport,
	type InMemoryKafkaTransportOptions,
	type KafkaBrokerTransport,
	type KafkaFetchedMessage,
	type KafkaFetchRequest,
	type KafkaProduceRequest,
	type KafkaProduceResult,
	resolveKafkaTransportFromEnv,
} from "./transport.js";
export type {
	KafkaClusterKind,
	KafkaClusterSpec,
	KafkaDoctorReport,
	KafkaRealizeResult,
	KafkaResourceDefinition,
	KafkaTopicResource,
} from "./types.js";
export { KAFKA_MESSAGING_CAPABILITIES } from "./types.js";

export const HOBO_PROVIDER_KAFKA_PACKAGE = "@hobo/provider-kafka";
