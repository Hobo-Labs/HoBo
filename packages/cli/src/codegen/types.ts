import type { JsonObject } from "../json.js";


export type {
	CodegenArtifact,
	CodegenReport,
	DriftEntry,
	TrainableStub,
} from "../_generated/project_codegen_pb.js";
export {
	CodegenArtifactSchema,
	CodegenReportSchema,
	DriftEntrySchema,
	TrainableStubSchema,
} from "../_generated/project_codegen_pb.js";

import type {
	CodegenArtifact,
	TrainableStub,
} from "../_generated/project_codegen_pb.js";

export interface CodegenSourceLayout {
	readonly wit: string;
	readonly zod: string;
	readonly allow: string;
	readonly bindle: string;
	readonly scanDir: string;
}

export interface CodegenGeneratedFiles {
	readonly manifest: string;
	readonly apiTree: string;
	readonly bindings: string;
	readonly hooks: string;
	readonly steps: string;
	readonly workflows: string;
	readonly withOptions: string;
	readonly trainables: string;
}

export interface CodegenGeneratedImports {
	readonly runtimeModule: string;
	readonly bindingsSpecifier: string;
}

export interface CodegenLayout {
	readonly sources: CodegenSourceLayout;
	readonly generatedRoots: readonly string[];
	readonly ownedFiles?: readonly string[];
	readonly files: CodegenGeneratedFiles;
	readonly imports: CodegenGeneratedImports;
}

export interface CodegenEngine {
	readonly layout: CodegenLayout;
	generate(projectRoot: string): Promise<readonly CodegenArtifact[]>;
	describeTrainables?(projectRoot: string): Promise<readonly TrainableStub[]>;
}

export class CodegenError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly detail: JsonObject = {},
	) {
		super(message);
		this.name = "CodegenError";
	}
}

export function defaultCodegenLayout(): CodegenLayout {
	return {
		sources: {
			wit: ".hobo/sources/wit/sdk.wit",
			zod: ".hobo/sources/zod/resources.json",
			allow: ".hobo/sources/allow/scopes.json",
			bindle: "hobo.bindle.json",
			scanDir: "src",
		},
		generatedRoots: [".hobo/generated", "src/_generated"],
		files: {
			manifest: ".hobo/generated/codegen-manifest.json",
			apiTree: "src/_generated/api-tree.ts",
			bindings: "src/_generated/bindings.d.ts",
			hooks: "src/_generated/hooks.ts",
			steps: "src/_generated/steps.ts",
			workflows: "src/_generated/workflows.ts",
			withOptions: "src/_generated/with-options.d.ts",
			trainables: "src/_generated/trainables.ts",
		},
		imports: {
			runtimeModule: "@hobo/runtime",
			bindingsSpecifier: "./bindings.js",
		},
	};
}
