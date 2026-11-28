import { runNativeKafkaPath } from "../src/scenarios.js";

const result = await runNativeKafkaPath("example");
if (result.published !== 2 || result.consumed !== 2) {
	throw new Error(
		`expected publish/consume 2/2 got ${result.published}/${result.consumed}`,
	);
}
console.log("native-kafka path: published=2 consumed=2");
