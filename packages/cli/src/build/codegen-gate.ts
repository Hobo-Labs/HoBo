import { toJson } from "@bufbuild/protobuf";
import {
	type CodegenFixtureOptions,
	writeFixtureProject,
} from "../codegen/fixture.js";
import { selectProjectCodegenEngine } from "../codegen/project-engine.js";
import { compareGeneratedTree, recoverGeneratedTree } from "../codegen/tree.js";
import { type CodegenEngine, DriftEntrySchema } from "../codegen/types.js";
import { BuildError } from "./errors.js";

export async function assertGeneratedFresh(
	projectRoot: string,
	engine?: CodegenEngine,
): Promise<void> {
	await recoverGeneratedTree(projectRoot, engine?.layout);
	const selected = engine ?? (await selectProjectCodegenEngine(projectRoot));
	const artifacts = await selected.generate(projectRoot);
	const drift = await compareGeneratedTree(
		projectRoot,
		artifacts,
		selected.layout.generatedRoots,
		{ ownedFiles: selected.layout.ownedFiles },
	);
	if (drift.length > 0) {
		throw new BuildError(
			"HOBO_BUILD_CODEGEN_DRIFT",
			"generated tree drift detected; run hobo codegen to refresh _generated/",
			{ drift: drift.map((entry) => toJson(DriftEntrySchema, entry)) },
		);
	}
}

export async function writeCodegenFixtureProject(
	projectRoot: string,
	options: CodegenFixtureOptions = {},
): Promise<void> {
	await writeFixtureProject(projectRoot, options);
}
