import { toJson } from "@bufbuild/protobuf";
import { runCodegen } from "../codegen/run-codegen.js";
import {
	type CodegenEngine,
	CodegenError,
	CodegenReportSchema,
} from "../codegen/types.js";
import type { JsonObject } from "../json.js";
import type { CommandModule } from "../shell/registry.js";

export interface CodegenCommandOptions {
	readonly engine?: CodegenEngine;
}

export function createCodegenCommand(
	options: CodegenCommandOptions = {},
): CommandModule {
	return {
		run: async ({ context, flags }) => {
			const projectRoot = context.projectDir ?? context.cwd;
			try {
				const result = await runCodegen(
					{ projectRoot, check: flags.check },
					options,
				);
				const count = flags.check
					? result.checked.length
					: result.written.length;
				return {
					ok: true,
					status: "ok",
					code: "HOBO_OK",
					message: flags.check
						? `hobo codegen ok (${count} generated files up to date)`
						: `hobo codegen ok (${count} generated files written)`,
					data: {
						command: "codegen",
						// SAFETY: `...(toJson(CodegenReportSchema, result) as JsonObject),` is required at this I/O or test boundary.
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
							"Run `hobo codegen` to rewrite the checked-in src/_generated/ tree from your project sources.",
						],
						data: { command: "codegen", detail: error.detail },
					};
				}
				throw error;
			}
		},
	};
}
