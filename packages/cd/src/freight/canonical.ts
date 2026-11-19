import type { JsonValue } from "@bufbuild/protobuf";
import { isJsonArray, isJsonObject } from "./json.js";

export function canonicalJson(value: JsonValue): string {
	if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isJsonObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
