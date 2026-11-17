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
	it("passes against the in-memory Kafka transport including DLQ", async () => {
		const report = await runMessagingConformance(
			() => {
				const bus = createKafkaMessaging({
					cluster: localRedpandaCluster("conf"),
					transport: createInMemoryKafkaTransport(),
				});
				expect(bus.fidelity).toBe("simulated");
				return bus;
			},
			{ backend: "native-kafka-memory-transport" },
		);
		expect(report.backend).toBe("native-kafka-memory-transport");
		expect(report.assertions.publishConsumeAck).toBe("pass");
		expect(report.assertions.consumerGroupIsolation).toBe("pass");
		expect(report.assertions.exactlyOnceCapabilityGate).toBe("pass");
		expect(report.assertions.deadLetterMaxAttempts).toBe("pass");
	});

	it("passes against the in-memory Dapr client including DLQ", async () => {
		const report = await runMessagingConformance(
			() => {
				const bus = createDaprMessaging({
					config: defaultDaprRuntimeConfig("conf", "camp"),
					client: createInMemoryDaprClient(),
				});
				expect(bus.fidelity).toBe("simulated");
				return bus;
			},
			{ backend: "dapr-pubsub-memory-client" },
		);
		expect(report.assertions.publishConsumeAck).toBe("pass");
		expect(report.assertions.consumerGroupIsolation).toBe("pass");
		expect(report.assertions.exactlyOnceCapabilityGate).toBe("pass");
		expect(report.assertions.deadLetterMaxAttempts).toBe("pass");
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
		expect(report.assertions.deadLetterMaxAttempts).toBe("pass");
	});
});
