// The parse boundary for change-window documents (protobuf JSON, as authored
// in files, the CLI or the control API). D10: rollback is allowed by default,
// so a document that omits `rollbackAllowed` allows it; only an explicit
// `false` forbids rollback during that window.
import { fromJson, type JsonValue } from "@bufbuild/protobuf";
import {
	type ChangeWindowRecord,
	ChangeWindowRecordSchema,
} from "../_generated/cd_pb.js";
import type { Outcome } from "../ports.js";
import { compileWindow } from "./evaluate.js";
import { isJsonObject } from "./journal.js";
import { refuse, WINDOW_REASON } from "./reasons.js";

export function parseChangeWindow(
	document: JsonValue,
): Outcome<ChangeWindowRecord> {
	if (!isJsonObject(document))
		return refuse(
			WINDOW_REASON.invalid,
			"a change window document must be a JSON object",
			"Write the window as protobuf JSON (hobo.cd.v1.ChangeWindowRecord).",
		);
	let record: ChangeWindowRecord;
	try {
		record = fromJson(ChangeWindowRecordSchema, document);
	} catch (error) {
		return refuse(
			WINDOW_REASON.invalid,
			`not a ChangeWindowRecord: ${error instanceof Error ? error.message : String(error)}`,
			"Use the protobuf JSON field names (name, kind, selector, rrule, durationMs, timezone, startsAt, endsAt, rollbackAllowed).",
		);
	}
	if (!("rollbackAllowed" in document) && !("rollback_allowed" in document))
		record.rollbackAllowed = true;
	const compiled = compileWindow(record);
	return compiled.ok ? { ok: true, value: record } : compiled;
}
