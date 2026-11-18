import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
	assertAgentDocsFresh,
	writeAgentDocs,
} from "../src/agent-docs/gate.js";

const { values } = parseArgs({
	options: {
		check: { type: "boolean", default: false },
		output: { type: "string" },
	},
});
const output = values.output
	? resolve(values.output)
	: join(dirname(fileURLToPath(import.meta.url)), "..", "agent-docs");

if (values.check) {
	await assertAgentDocsFresh(output);
	console.log(`agent docs are current: ${output}`);
} else {
	for (const path of await writeAgentDocs(output)) console.log(`wrote ${path}`);
}
