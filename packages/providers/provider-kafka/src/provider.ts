import { type JsonValue, parseJsonValue } from "./json.js";

import { KAFKA_PROVIDER_ID, publishCapabilityManifest } from "./manifest.js";
import { createKafkaMessaging } from "./messaging.js";
import { localRedpandaCluster, realizeKafkaResources } from "./realize.js";
import type { KafkaBrokerTransport } from "./transport.js";
import { resolveKafkaTransportFromEnv } from "./transport.js";
import type { KafkaClusterSpec, KafkaRealizeResult } from "./types.js";
import { KAFKA_MESSAGING_CAPABILITIES } from "./types.js";

export interface KafkaProviderOptions {
	readonly cluster?: KafkaClusterSpec;
	readonly tenantId?: string;
	readonly transport?: KafkaBrokerTransport;
	readonly env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface KafkaCapabilityProvider {
	readonly id: typeof KAFKA_PROVIDER_ID;
	readonly witExports: readonly string[];
	readonly capabilities: typeof KAFKA_MESSAGING_CAPABILITIES;
	capabilityManifest(): ReturnType<typeof publishCapabilityManifest>;
	realize(input: {
		cluster?: JsonValue;
		topics?: readonly JsonValue[];
	}): KafkaRealizeResult;
	createMessaging(options?: {
		live?: boolean;
		transport?: KafkaBrokerTransport;
	}): ReturnType<typeof createKafkaMessaging>;
}

export function createKafkaProvider(
	options: KafkaProviderOptions = {},
): KafkaCapabilityProvider {
	const tenantId = options.tenantId ?? "local";
	const cluster = options.cluster ?? localRedpandaCluster(tenantId);
	const defaultTransport =
		options.transport ??
		resolveKafkaTransportFromEnv(options.env ?? process.env);

	return Object.freeze({
		id: KAFKA_PROVIDER_ID,
		witExports: [],
		capabilities: KAFKA_MESSAGING_CAPABILITIES,
		capabilityManifest: () => publishCapabilityManifest(),
		realize(input: { cluster?: JsonValue; topics?: readonly JsonValue[] }) {
			return realizeKafkaResources({
				cluster: input.cluster ?? parseJsonValue(JSON.stringify(cluster)),
				...(input.topics !== undefined ? { topics: input.topics } : undefined),
			});
		},
		createMessaging(opts?: {
			live?: boolean;
			transport?: KafkaBrokerTransport;
		}) {
			const transport = opts?.transport ?? defaultTransport;
			return createKafkaMessaging({
				cluster,
				...(transport ? { transport } : undefined),
				...(opts?.live !== undefined ? { live: opts.live } : undefined),
			});
		},
	});
}
