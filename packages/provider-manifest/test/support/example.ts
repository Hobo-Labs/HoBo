import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { JsonValue } from "@bufbuild/protobuf";
import { toJson } from "@bufbuild/protobuf";
import {
	type ParsedProviderManifest,
	ProviderManifestSchema,
	parseProviderManifest,
} from "../../src/index.js";

export const EXAMPLE_PATH = fileURLToPath(
	new URL("../../examples/acme-cloud.provider.yaml", import.meta.url),
);

export const EXAMPLE_TEXT = readFileSync(EXAMPLE_PATH, "utf8");

export function mustParse(text: string): ParsedProviderManifest {
	const result = parseProviderManifest(text);
	if (!result.ok) {
		throw new Error(
			result.issues.map((i) => `${i.path}: ${i.message}`).join("\n"),
		);
	}
	return result.manifest;
}

export function example(): ParsedProviderManifest {
	return mustParse(EXAMPLE_TEXT);
}

type Json = { [key: string]: JsonValue };

export function exampleJson(): Json {
	return structuredClone(toJson(ProviderManifestSchema, example())) as Json;
}

export function at(value: JsonValue | undefined, ...path: (string | number)[]) {
	let current: JsonValue | undefined = value;
	for (const key of path) {
		current = (current as Record<string | number, JsonValue>)[key];
	}
	return current as Json;
}
