import { resolve } from "node:path";

import { toJson } from "@bufbuild/protobuf";
import { scanAmbientTrainableClasses } from "../codegen/ambient-trainables.js";
import { loadSourceModel } from "../codegen/engine.js";
import { selectProjectCodegenEngine } from "../codegen/project-engine.js";
import { runCodegen } from "../codegen/run-codegen.js";
import {
	buildTrainables,
	scanTrainableDirectives,
} from "../codegen/trainables.js";
import {
	type CodegenEngine,
	CodegenError,
	CodegenReportSchema,
	TrainableStubSchema,
} from "../codegen/types.js";
import type { JsonObject } from "../json.js";
import type { CommandModule } from "../shell/registry.js";

export interface StubCommandOptions {
	readonly engine?: CodegenEngine;
}

export function createStubCommand(
	options: StubCommandOptions = {},
): CommandModule {
	return {
		run: async ({ context, flags }) => {
			const projectRoot = resolve(context.projectDir ?? context.cwd);
			const engine =
				options.engine ?? (await selectProjectCodegenEngine(projectRoot));
			const layout = engine.layout;
			try {
				const result = await runCodegen(
					{ projectRoot, check: flags.check },
					{ engine },
				);
				const stubs = engine.describeTrainables
					? await engine.describeTrainables(projectRoot)
					: await (async () => {
							const model = await loadSourceModel(projectRoot, layout.sources);
							const directives = await scanTrainableDirectives(
								projectRoot,
								layout,
							);
							const ambient = await scanAmbientTrainableClasses(
								projectRoot,
								layout,
							);
							return buildTrainables(model, layout, directives, ambient).stubs;
						})();
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: `hobo stub ok (${stubs.length} contract-backed trainable stubs)`,
					data: {
						command: "stub",
						trainables: stubs.map((stub) => toJson(TrainableStubSchema, stub)),
						...(toJson(CodegenReportSchema, result) as JsonObject),
					},
				};
			} catch (error) {
				if (error instanceof CodegenError) {
					return {
						ok: false,
						status: "error",
						code: error.code,
						message: error.message,
						remediation: [
							"Run `hobo stub` (or `hobo codegen`) to rewrite the checked-in src/_generated/ tree, including the trainable stubs.",
						],
						data: { command: "stub", detail: error.detail },
					};
				}
				throw error;
			}
		},
	};
}
