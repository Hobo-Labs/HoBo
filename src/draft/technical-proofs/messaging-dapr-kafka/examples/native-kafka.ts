/**
 * Example: native Kafka messaging path (ports only).
 * Run: pnpm exec tsx examples/native-kafka.ts
 */

import { runNativeKafkaPath } from "../src/scenarios.js";

const result = await runNativeKafkaPath("demo");
console.log(
	JSON.stringify(
		{
			backend: result.messaging.backend,
			published: result.published,
			consumed: result.consumed,
			audit: result.events,
		},
		null,
		2,
	),
);
