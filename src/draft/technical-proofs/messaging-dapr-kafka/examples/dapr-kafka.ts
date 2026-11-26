/**
 * Example: Dapr runtime + pubsub.kafka component YAML (ports only).
 * Run: pnpm exec tsx examples/dapr-kafka.ts
 */

import { runDaprKafkaPath } from "../src/scenarios.js";

const result = await runDaprKafkaPath("demo");
console.log(
	JSON.stringify(
		{
			appId: result.appId,
			published: result.published,
			consumed: result.consumed,
			yamlPreview: result.yaml.split("\n").slice(0, 12).join("\n"),
		},
		null,
		2,
	),
);
