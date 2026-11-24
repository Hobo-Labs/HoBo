import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { isJsonObject, isJsonString } from "../json.js";
import { buildProjectFiles } from "../templates/index.js";
import { parseProjectName, parseTemplateId } from "../types/scaffold.js";
import { createProjectCodegenEngine } from "./engine.js";
import { stableStringify } from "./text.js";
import { recoverGeneratedTree } from "./tree.js";
import {
	CodegenArtifactSchema,
	type CodegenEngine,
	CodegenError,
	defaultCodegenLayout,
} from "./types.js";
import {
	createTypeScriptProjectCodegenEngine,
	selectTypeScriptProjectCodegenEngine,
} from "./typescript-project-engine.js";

export async function selectProjectCodegenEngine(
	projectRoot: string,
): Promise<CodegenEngine> {
	await recoverGeneratedTree(projectRoot);
	if (existsSync(join(projectRoot, defaultCodegenLayout().sources.zod)))
		return createProjectCodegenEngine();
	const inferTypeScript = async () =>
		(await selectTypeScriptProjectCodegenEngine(projectRoot)) ??
		createProjectCodegenEngine();
	let source: string;
	try {
		source = await readFile(join(projectRoot, "hobo.bindle.json"), "utf8");
	} catch {
		return inferTypeScript();
	}
	let metadata: unknown;
	try {
		metadata = JSON.parse(source);
	} catch {
		return inferTypeScript();
	}
	if (
		!isJsonObject(metadata) ||
		metadata.schemaVersion !== "hobo.bindle/v1" ||
		!isJsonString(metadata.template)
	)
		return inferTypeScript();
	try {
		if (!isJsonString(metadata.name))
			throw new Error("starter name must be a string");
		const files = buildProjectFiles({
			name: parseProjectName(metadata.name),
			template: parseTemplateId(metadata.template),
		});
		const canonical = files.get("hobo.bindle.json");
		if (
			canonical === undefined ||
			stableStringify(JSON.parse(canonical)) !== stableStringify(metadata)
		) {
			return inferTypeScript();
		}
		const artifacts = [...files]
			.filter(([path]) => path.startsWith("src/_generated/"))
			.map(([path, content]) =>
				create(CodegenArtifactSchema, { path, content }),
			);
		const imprint = createTypeScriptProjectCodegenEngine({
			sourceOverrides: Object.fromEntries(
				artifacts.map((artifact) => [artifact.path, artifact.content]),
			),
		});
		return {
			layout: {
				...imprint.layout,
				generatedRoots: imprint.layout.generatedRoots,
				ownedFiles: artifacts.map((artifact) => artifact.path),
			},
			async generate(root) {
				return [...artifacts, ...(await imprint.generate(root))];
			},
			describeTrainables: (root) =>
				imprint.describeTrainables?.(root) ?? Promise.resolve([]),
		};
	} catch (error) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			error instanceof Error ? error.message : "Invalid starter metadata",
			{ file: "hobo.bindle.json" },
		);
	}
}
