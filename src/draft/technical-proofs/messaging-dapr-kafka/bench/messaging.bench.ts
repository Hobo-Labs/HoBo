import { bench, describe } from "vitest";

import { createKafkaMessaging, localRedpandaCluster } from "@hobo/provider-kafka";
import { parseTopicName } from "@hobo/core";

describe("messaging publish bench (advisory)", () => {
	bench("kafka-simulated publish 100", async () => {
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("bench"),
		});
		const topic = parseTopicName("bench");
		for (let i = 0; i < 100; i++) {
			await bus.publish(topic, { i });
		}
	});
});
