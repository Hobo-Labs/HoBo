import path from "node:path";
import { fileURLToPath } from "node:url";
import { describeConcern } from "@hobo/contract-harness";

import * as naming from "../src/naming.js";

describeConcern("naming", {
	subject: () => naming,
	cases: path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"naming.cases.jsonl",
	),
});
