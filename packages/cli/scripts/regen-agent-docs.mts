import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { writeAgentDocs } from "../src/agent-docs/gate.js";

// Regenerates the checked-in agent-docs surface from CANONICAL_VERBS, which is
// its only source of truth. agent-docs.test.ts drift-gates the result, so this
// runs whenever the canonical verb list changes.
const written = await writeAgentDocs(
	join(dirname(fileURLToPath(import.meta.url)), "..", "agent-docs"),
);
for (const path of written) {
	console.log(`wrote ${path}`);
}
