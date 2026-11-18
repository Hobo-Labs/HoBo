import { resolve } from "node:path";

import { create, toJson } from "@bufbuild/protobuf";
import { selectProjectCodegenEngine } from "./project-engine.js";
import { generateResourceAliases } from "./resource-aliases.js";
import {
	compareGeneratedTree,
	recoverGeneratedTree,
	writeGeneratedTree,
} from "./tree.js";
import {
	type CodegenEngine,
	CodegenError,
	type CodegenReport,
	CodegenReportSchema,
	DriftEntrySchema,
} from "./types.js";

export interface CodegenRequest {
	readonly projectRoot: string;
	readonly check: boolean;
}

export interface CodegenDependencies {
	readonly engine?: CodegenEngine;
}

export async function runCodegen(
	request: CodegenRequest,
	deps: CodegenDependencies = {},
): Promise<CodegenReport> {
	const projectRoot = resolve(request.projectRoot);
	await recoverGeneratedTree(projectRoot, deps.engine?.layout);
	const engine = deps.engine ?? (await selectProjectCodegenEngine(projectRoot));
	const artifacts = [...(await engine.generate(projectRoot))];
	const aliases = await generateResourceAliases(projectRoot, engine.layout);
	if (aliases) artifacts.push(aliases);
	const paths = artifacts.map((artifact) => artifact.path);

	if (request.check) {
		const drift = await compareGeneratedTree(
			projectRoot,
			artifacts,
			engine.layout.generatedRoots,
			{ ownedFiles: engine.layout.ownedFiles },
		);
		if (drift.length > 0) {
			throw new CodegenError(
				"HOBO_CODEGEN_DRIFT",
				"generated tree drift detected",
				{ drift: drift.map((entry) => toJson(DriftEntrySchema, entry)) },
			);
		}
		return create(CodegenReportSchema, { mode: "check", checked: paths });
	}

	await writeGeneratedTree(
		projectRoot,
		artifacts,
		engine.layout.generatedRoots,
		{ ownedFiles: engine.layout.ownedFiles },
	);
	return create(CodegenReportSchema, { mode: "write", written: paths });
}
