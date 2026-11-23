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
