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
	`${events.map((e) => canonicalJson(e as never)).join("\n")}\n`,
);
