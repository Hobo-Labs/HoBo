/**
 * The whole suite is the case file beside this one.
 *
 * `describeConcern` reads `capability-manifest.cases.jsonl`, groups by member,
 * and emits one test per member — so adding a case is a one-line data diff
 * rather than another copy of arrange-act-assert. It also fails if any exported
 * member has no cases, which is the part a hand-written suite cannot do.
 *
 * The pinned digests are what stop the algorithm drifting back to something
 * cheaper: these documents are fetched from a provider-controlled origin, so a
 * reference that only detects accidental corruption is not integrity.
 */
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
