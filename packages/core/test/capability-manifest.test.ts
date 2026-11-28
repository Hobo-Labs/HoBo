import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConcern } from "@hobo/contract-harness";

import * as capabilityManifest from "../src/ports/capability-manifest.js";

describeConcern("capability-manifest codec", {
	subject: () => capabilityManifest,
	cases: path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"capability-manifest.cases.jsonl",
	),
});
