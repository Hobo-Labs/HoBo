/**
 * Cases live in `naming.cases.jsonl`; this file only says what the concern is.
 *
 * `describeConcern` also fails if `naming.ts` grows an export with no cases,
 * which is the hole a hand-written suite leaves open.
 */
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
