import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { create } from "@bufbuild/protobuf";
import type { CodegenFieldSchema } from "../_generated/project_codegen_pb.js";
import { isJsonObject, type JsonValue } from "../json.js";
import { scanAmbientTrainableClasses } from "./ambient-trainables.js";
import { isPlainIdentifier } from "./identifiers.js";
import { renderRuntimeArtifacts } from "./runtime-artifacts.js";
import {
	exampleSchemaValue,
	parseFieldSchema,
	renderSchemaType,
	schemaRuntimeSource,
	serializedSchema,
} from "./schema.js";
import {
	digest,
	pascalCase,
	stableStringify,
	toStableValue,
	union,
} from "./text.js";
import { buildTrainables, scanTrainableDirectives } from "./trainables.js";
import {
	type CodegenArtifact,
	CodegenArtifactSchema,
	type CodegenEngine,
	CodegenError,
	type CodegenLayout,
	type CodegenSourceLayout,
	defaultCodegenLayout,
} from "./types.js";


export interface ProjectCodegenEngineOptions {
	readonly layout?: CodegenLayout;
}

export function createProjectCodegenEngine(
	options: ProjectCodegenEngineOptions = {},
): CodegenEngine {
	const layout = options.layout ?? defaultCodegenLayout();

	return {
		layout,
		async generate(projectRoot: string): Promise<readonly CodegenArtifact[]> {
			const model = await loadSourceModel(projectRoot, layout.sources);
			const directives = await scanTrainableDirectives(projectRoot, layout);
			const ambient = await scanAmbientTrainableClasses(projectRoot, layout);
			const trainables = buildTrainables(model, layout, directives, ambient);
			const { files } = layout;
			const artifact = (path: string, content: string) =>
				create(CodegenArtifactSchema, { path, content });

			return [
				artifact(
					files.manifest,
					stableStringify({
						schema: "hobo.codegen-manifest/v1",
						generatedBy: "hobo codegen",
						guestLanguage: "ts",
						layout: layout.generatedRoots,
						sourceDigests: digestSources(model.rawSources),
						resources: model.resources.map((resource) => resource.name),
						scopes: model.scopes.map((scope) => scope.name),
						bindles: model.bindles.map((bindle) => bindle.name),
					}),
				),
				artifact(files.bindings, renderBindings(model)),
				artifact(files.withOptions, renderWithOptions(model)),
				...renderRuntimeArtifacts(model, layout, {
					validationSource: schemaRuntimeSource(),
					schemas: {
						...Object.fromEntries(
							[...(model.definitions ?? [])].map(([name, schema]) => [
								name,
								serializedSchema(schema),
							]),
						),
						...Object.fromEntries(
							model.resources.map((resource) => [
								resource.name,
								resource.schema ? serializedSchema(resource.schema) : {},
							]),
						),
					},
				}),
				trainables.artifact,
				...trainables.declaredArtifacts,
			];
		},
	};
}

export async function loadSourceModel(
	projectRoot: string,
	sources: CodegenSourceLayout,
): Promise<SourceModel> {
	return normalizeSourceModel(
		await readProjectSources(projectRoot, sources),
		sources,
	);
}

interface ProjectSources {
	readonly wit: string;
	readonly zod: JsonValue;
	readonly allow: JsonValue;
	readonly bindle: JsonValue;
}

async function readProjectSources(
	projectRoot: string,
	sources: CodegenSourceLayout,
): Promise<ProjectSources> {
	return {
		wit: await readTextSource(projectRoot, sources.wit),
		zod: await readJsonSource(projectRoot, sources.zod),
		allow: await readJsonSource(projectRoot, sources.allow),
		bindle: await readJsonSource(projectRoot, sources.bindle),
	};
}

async function readTextSource(
	projectRoot: string,
	path: string,
): Promise<string> {
	try {
		return await readFile(join(projectRoot, path), "utf8");
	} catch (error) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`Cannot read ${path}: ${error instanceof Error ? error.message : error}`,
			{ file: path },
		);
	}
}

async function readJsonSource(
	projectRoot: string,
	path: string,
): Promise<JsonValue> {
	const source = await readTextSource(projectRoot, path);
	try {
		return JSON.parse(source);
	} catch (error) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`Cannot parse ${path}: ${error instanceof Error ? error.message : error}`,
			{ file: path },
		);
	}
}

interface RawZod {
	readonly resources?: Record<string, JsonValue>;
	readonly definitions?: Record<string, JsonValue>;
	readonly $defs?: Record<string, JsonValue>;
}
interface RawAllow {
	readonly scopes?: Record<string, { readonly grants?: readonly string[] }>;
}
interface RawBindle {
	readonly name: string;
	readonly provider: string;
	readonly resources?: readonly string[];
	readonly steps?: readonly string[];
	readonly workflows?: readonly string[];
	readonly with?: Record<string, readonly string[]>;
}
interface RawBindleFile {
	readonly bindles?: readonly RawBindle[];
}

export interface SourceModelField {
	readonly name: string;
	readonly type: string;
	readonly example: JsonValue | undefined;
	readonly schema?: CodegenFieldSchema;
	readonly optional?: boolean;
}

export interface SourceModelResource {
	readonly name: string;
	readonly typeName: string;
	readonly fields: readonly SourceModelField[];
	readonly schema?: CodegenFieldSchema;
	readonly example?: JsonValue;
}

export interface SourceModelBindle {
	readonly name: string;
	readonly provider: string;
	readonly resources: readonly string[];
	readonly steps: readonly string[];
	readonly workflows: readonly string[];
	readonly with: readonly {
		readonly name: string;
		readonly values: readonly string[];
	}[];
}

export interface SourceModel {
	readonly rawSources: Record<string, string>;
	readonly resources: readonly SourceModelResource[];
	readonly scopes: readonly {
		readonly name: string;
		readonly grants: readonly string[];
	}[];
	readonly bindles: readonly SourceModelBindle[];
	readonly definitions?: ReadonlyMap<string, CodegenFieldSchema>;
}

function normalizeSourceModel(
	sources: ProjectSources,
	layout: CodegenSourceLayout,
): SourceModel {
	const rawSources = {
		wit: sources.wit,
		zod: stableStringify(sources.zod),
		allow: stableStringify(sources.allow),
		bindle: stableStringify(sources.bindle),
	};

	assertValidWitSource(sources.wit, layout.wit);
	const zod = toStableValue(sources.zod) as RawZod;
	const allow = toStableValue(sources.allow) as RawAllow;
	const bindle = toStableValue(sources.bindle) as RawBindleFile;

	const schemas = new Map(
		Object.entries(zod.resources ?? {}).map(([name, raw]) => {
			if (!isJsonObject(raw))
				throw new CodegenError(
					"HOBO_CODEGEN_SOURCE_PARSE",
					`Resource ${name} must define a schema`,
				);
			return [
				name,
				parseFieldSchema(
					{ type: "object", ...Object.fromEntries(Object.entries(raw)) },
					`resources.${name}`,
				),
			] as const;
		}),
	);
	const definitions = new Map(
		Object.entries({ ...zod.definitions, ...zod.$defs }).map(
			([name, raw]) =>
				[name, parseFieldSchema(raw, `definitions.${name}`)] as const,
		),
	);
	const allSchemas = new Map([...definitions, ...schemas]);
	const typeNames = new Set([
		"ResourceName",
		"HoboApiTree",
		"StepSignatures",
		"WorkflowSignatures",
	]);
	for (const [name, schema] of [...definitions, ...schemas]) {
		const typeName = pascalCase(name);
		if (!isPlainIdentifier(typeName) || typeNames.has(typeName))
			throw new CodegenError(
				"HOBO_CODEGEN_SOURCE_PARSE",
				`Schema ${JSON.stringify(name)} generates an invalid or duplicate type name ${JSON.stringify(typeName)}`,
				{ file: layout.zod },
			);
		typeNames.add(typeName);
		const checkReferences = (node: CodegenFieldSchema): void => {
			if (node.kind === "ref" && !allSchemas.has(node.reference))
				throw new CodegenError(
					"HOBO_CODEGEN_SOURCE_PARSE",
					`Schema ${JSON.stringify(name)} references unknown schema ${JSON.stringify(node.reference)}`,
					{ file: layout.zod },
				);
			for (const child of Object.values(node.fields)) checkReferences(child);
			for (const child of [...node.variants, ...node.tuple])
				checkReferences(child);
			if (node.items) checkReferences(node.items);
		};
		checkReferences(schema);
	}
	const resources = [...schemas]
		.map(([name, schema]) => {
			const example = exampleSchemaValue(schema, allSchemas);
			return {
				name,
				typeName: pascalCase(name),
				schema,
				example,
				fields: Object.entries(schema.fields).map(([fieldName, field]) => ({
					name: fieldName,
					type: renderSchemaType(field),
					example: isJsonObject(example) ? example[fieldName] : undefined,
					schema: field,
					optional: field.optional,
				})),
			};
		})
		.sort((left, right) => left.name.localeCompare(right.name));

	if (resources.length === 0) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			"resources.json must define at least one resource",
			{ file: layout.zod },
		);
	}
	const scopes = Object.entries(allow.scopes ?? {})
		.map(([name, scope]) => ({
			name,
			grants: [...(scope.grants ?? [])].sort(),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));

	const bindles = [...(bindle.bindles ?? [])]
		.map((entry) => ({
			name: entry.name,
			provider: entry.provider,
			resources: [...(entry.resources ?? [])].sort(),
			steps: [...(entry.steps ?? [])].sort(),
			workflows: [...(entry.workflows ?? [])].sort(),
			with: Object.entries(entry.with ?? {})
				.map(([name, values]) => ({ name, values: [...values].sort() }))
				.sort((left, right) => left.name.localeCompare(right.name)),
		}))
		.sort((left, right) => left.name.localeCompare(right.name));

	return { rawSources, resources, scopes, bindles, definitions };
}

function assertValidWitSource(source: string, witPath: string): void {
	if (!/^package\s+hobo:sdk@0\.1\.0;/m.test(source)) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`${witPath} must declare package hobo:sdk@0.1.0`,
			{ file: witPath },
		);
	}
	if (!/^world\s+app\s+\{/m.test(source)) {
		throw new CodegenError(
			"HOBO_CODEGEN_SOURCE_PARSE",
			`${witPath} must declare world app`,
			{ file: witPath },
		);
	}
}

function propertyName(name: string): string {
	return isPlainIdentifier(name) ? name : JSON.stringify(name);
}

function renderBindings(model: SourceModel): string {
	const interfaces = model.resources
		.map((resource) => {
			const fields = resource.fields
				.map(
					(field) =>
						`  ${propertyName(field.name)}${field.optional ? "?" : ""}: ${field.type};`,
				)
				.join("\n");
			return resource.schema &&
				(resource.schema.kind !== "object" || resource.schema.items)
				? `export type ${resource.typeName} = ${renderSchemaType(resource.schema)};`
				: `export interface ${resource.typeName} {\n${fields}\n}`;
		})
		.join("\n\n");
	const resourceNames = union(model.resources.map((resource) => resource.name));

	const definitions = [...(model.definitions ?? [])]
		.map(
			([name, schema]) =>
				`export type ${pascalCase(name)} = ${renderSchemaType(schema)};`,
		)
		.join("\n");
	return `${interfaces}\n${definitions}\nexport type ResourceName = ${resourceNames};\n`;
}

function renderWithOptions(model: SourceModel): string {
	const providerEntries = model.bindles
		.map((bindle) => {
			const options = bindle.with
				.map(
					(entry) => `    ${propertyName(entry.name)}: ${union(entry.values)};`,
				)
				.join("\n");
			return `  | { provider: ${JSON.stringify(bindle.provider)}; options: {\n${options}\n    } }`;
		})
		.join("\n");

	return `export type ProviderWithOptions =\n${providerEntries || "never"};\n`;
}

function digestSources(
	sources: Record<string, string>,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(sources)
			.map(([name, source]) => [name, digest(source)] as const)
			.sort(([left], [right]) => left.localeCompare(right)),
	);
}
