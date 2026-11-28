import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeAgentDocs } from "../src/agent-docs/gate.js";

const written = await writeAgentDocs(
	join(dirname(fileURLToPath(import.meta.url)), "..", "agent-docs"),
);
for (const path of written) {
	console.log(`wrote ${path}`);
}
