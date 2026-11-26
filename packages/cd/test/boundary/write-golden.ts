// Regenerate the CDEvents golden file after an intentional spec or projection
// change: `node --import tsx test/boundary/write-golden.ts` from packages/cd.
// Review the diff; the golden test pins it byte for byte.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CDEVENTS_SPEC,
	canonicalJson,
	projectCdEvents,
} from "../../src/boundary/index.js";
import { fixtureJournal } from "./journal.js";

const here = dirname(fileURLToPath(import.meta.url));
const events = projectCdEvents(fixtureJournal(), { source: "/hobo/cd/acme" });
writeFileSync(
	join(here, `golden/cdevents.v${CDEVENTS_SPEC.specversion}.jsonl`),
	// SAFETY: CdEvent is a JSON-shaped record.
	`${events.map((e) => canonicalJson(e as never)).join("\n")}\n`,
);
