import {
	createInMemoryKafkaTransport,
	createKafkaMessaging,
	localRedpandaCluster,
} from "@hobo/provider-kafka";
import {
	createDaprMessaging,
	createInMemoryDaprClient,
	defaultDaprRuntimeConfig,
} from "@hobo/runtime-dapr";
import { describe, expect, it } from "vitest";

import { runMessagingConformance } from "../src/messaging-conformance.js";

describe("messaging conformance against adapters", () => {
	it("passes against live Kafka transport path and reports unsupported dead-letter transfer", async () => {
		const report = await runMessagingConformance(
			() =>
				createKafkaMessaging({
					cluster: localRedpandaCluster("conf"),
					transport: createInMemoryKafkaTransport(),
				}),
			{ backend: "native-kafka-live" },
		);
		expect(report.backend).toBe("native-kafka-live");
		expect(report.assertions.publishConsumeAck).toBe("pass");
		expect(report.assertions.consumerGroupIsolation).toBe("pass");
		expect(report.assertions.exactlyOnceCapabilityGate).toBe("pass");
		expect(report.assertions.deadLetterMaxAttempts).toBe("unsupported");
	});

	it("passes against live Dapr client path and reports unsupported dead-letter transfer", async () => {
		const report = await runMessagingConformance(
			() =>
				createDaprMessaging({
					config: defaultDaprRuntimeConfig("conf", "camp"),
					client: createInMemoryDaprClient(),
				}),
			{ backend: "dapr-pubsub-live" },
		);
		expect(report.assertions.publishConsumeAck).toBe("pass");
		expect(report.assertions.consumerGroupIsolation).toBe("pass");
		expect(report.assertions.exactlyOnceCapabilityGate).toBe("pass");
		expect(report.assertions.deadLetterMaxAttempts).toBe("unsupported");
	});

	it("passes against simulated Kafka (no transport)", async () => {
		const report = await runMessagingConformance(
			() =>
				createKafkaMessaging({
					cluster: localRedpandaCluster("conf"),
				}),
			{ backend: "native-kafka-simulated" },
		);
		expect(report.assertions.publishConsumeAck).toBe("pass");
		expect(report.assertions.deadLetterMaxAttempts).toBe("unsupported");
	});
});
