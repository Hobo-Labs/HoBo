import {
	type ProvenanceStatement,
	parseProvenanceStatement,
} from "@hobo/registry";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	objectAt,
	parseJsonText,
	stringAt,
} from "../artifacts/json.js";

export type StatementResult =
	| Readonly<{ ok: true; statement: ProvenanceStatement }>
	| Readonly<{ ok: false; detail: string }>;

const decoder = new TextDecoder("utf-8", { fatal: true });

function liftV1Builder(raw: JsonObject): JsonObject | string {
	const predicate = objectAt(raw, "predicate");
	if (predicate === undefined) return raw;
	const runDetails = objectAt(predicate, "runDetails");
	const v1 =
		runDetails === undefined ? undefined : objectAt(runDetails, "builder");
	const v1Id = v1 === undefined ? undefined : stringAt(v1, "id");
	if (v1Id === undefined) return raw;
	const legacy = objectAt(predicate, "builder");
	const legacyId = legacy === undefined ? undefined : stringAt(legacy, "id");
	if (legacyId !== undefined && legacyId !== v1Id)
		return "predicate names two different builders (builder.id and runDetails.builder.id)";
	const lifted: JsonObject = {
		...predicate,
		builder: { ...legacy, id: v1Id },
	};
	return { ...raw, predicate: lifted };
}

export function parseStatement(bytes: Uint8Array): StatementResult {
	let raw: JsonValue | undefined;
	try {
		raw = parseJsonText(decoder.decode(bytes));
	} catch {
		raw = undefined;
	}
	if (raw === undefined)
		return { ok: false, detail: "the statement is not UTF-8 JSON" };
	const view = isJsonObject(raw) ? liftV1Builder(raw) : raw;
	if (isJsonString(view)) return { ok: false, detail: view };
	const parsed = parseProvenanceStatement(view);
	if (!parsed.ok)
		return {
			ok: false,
			detail: parsed.errors
				.map((error) => `${error.code}: ${error.message}`)
				.join("; "),
		};
	return { ok: true, statement: parsed.statement };
}
