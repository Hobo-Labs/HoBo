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

/** The example as editable JSON, for building one-defect variants. */
export function exampleJson(): Json {
	// SAFETY: a message's JSON form is always an object.
	return structuredClone(toJson(ProviderManifestSchema, example())) as Json;
}

/** Walk into nested test JSON by key / index without a cast at every hop. */
export function at(value: JsonValue | undefined, ...path: (string | number)[]) {
	let current: JsonValue | undefined = value;
	for (const key of path) {
		// SAFETY: test-only traversal of a document whose shape the test wrote.
		current = (current as Record<string | number, JsonValue>)[key];
	}
	// SAFETY: callers mutate the object they navigated to.
	return current as Json;
}
