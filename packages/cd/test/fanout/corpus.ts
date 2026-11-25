// Golden-corpus file I/O shared by the WP23 golden tests.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue } from "@bufbuild/protobuf";
import { isJsonObject } from "../../src/fanout/journal.js";

export function readCorpus(file: string): Map<string, JsonValue> {
	const parsed: JsonValue = JSON.parse(readFileSync(file, "utf8"));
	return new Map(isJsonObject(parsed) ? Object.entries(parsed) : []);
}

/** Rewrite the corpus only when asked (UPDATE_GOLDEN=1). */
export function maybeWriteCorpus(
	file: string,
	current: ReadonlyMap<string, JsonValue>,
): void {
	if (process.env.UPDATE_GOLDEN !== "1") return;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		`${JSON.stringify(Object.fromEntries(current), null, "\t")}\n`,
	);
}
