import { existsSync } from "node:fs";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
	loadBindleDefinition,
	RESOURCE_IDENTITY_FILE,
} from "../cloud/loader.js";
import {
	type CodegenArtifact,
	CodegenArtifactSchema,
	CodegenError,
	type CodegenLayout,
} from "./types.js";

export async function generateResourceAliases(
	projectRoot: string,
	layout: CodegenLayout,
): Promise<CodegenArtifact | null> {
	if (!existsSync(join(projectRoot, RESOURCE_IDENTITY_FILE))) return null;
	let definition: Awaited<ReturnType<typeof loadBindleDefinition>>;
	try {
		definition = await loadBindleDefinition(projectRoot);
	} catch (error) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			error instanceof Error
				? error.message
				: "Invalid resource identity ledger",
			{ file: RESOURCE_IDENTITY_FILE },
		);
	}
	if (definition?.deploymentIdentity !== "generated") {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			"resource identity ledger requires a loadable Bindle source",
			{ file: RESOURCE_IDENTITY_FILE },
		);
	}
	const root =
		layout.generatedRoots.find((candidate) => candidate.startsWith("src/")) ??
		layout.generatedRoots[0];
	if (!root) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			"resource aliases require a generated root",
		);
	}
	const aliases = Object.entries(definition.resources)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([alias, resource]) => {
			if (!resource.generatedId) {
				throw new CodegenError(
					"HOBO_CODEGEN_SOURCE_PARSE",
					`resource ${alias} has no generated ID`,
				);
			}
			return `  readonly ${JSON.stringify(alias)}: ResourceBinding<${JSON.stringify(resource.generatedId)}, ${JSON.stringify(resource.kind)}>;`;
		});
	const content = [
		"export interface ResourceBinding<Id extends string, Kind extends string> {",
		"  readonly generatedId: Id;",
		"  readonly kind: Kind;",
		"}",
		"",
		"export interface ResourceAliases {",
		...aliases,
		"}",
		"",
	].join("\n");
	return create(CodegenArtifactSchema, {
		path: `${root}/resource-aliases.d.ts`,
		content,
	});
}
