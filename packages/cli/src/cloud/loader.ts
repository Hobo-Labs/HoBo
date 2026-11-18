import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	applyResourceIdentityLedger,
	type BindleDefinition,
	type CollectionContext,
	CollectionEngineError,
	type CollectionTarget,
	collectBindleManifest,
	evaluateBindingDeliveryGate,
	type ManifestV1,
	type ProviderAnnotation,
	type ResourceIdentityLedger,
	readDependencyConfig,
	resourceIdentityLedger,
} from "@hobo/bindles";
import {
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonValue,
} from "../json.js";
import { BindleImportError } from "../shell/errors.js";
import {
	type AppHttpModule,
	httpDefinitionFromModule,
	loadTypeScriptHttpDefinition,
} from "./typescript-app-loader.js";

export const BINDLE_SOURCE_CANDIDATES = [
	"dist/bindle.js",
	"dist/src/bindle.js",
	"src/bindle.js",
	"src/bindle.mjs",
	"src/bindle.ts",
	"src/bindle.mts",
	"dist/app.js",
	"app.js",
	"app.mjs",
	"app.ts",
	"app.mts",
] as const;

export const DEFAULT_COMPONENT_HOST = {
	kind: "wasmtime",
	version: "46.0.1",
} as const;

export const RESOURCE_IDENTITY_FILE = "hobo.resource-identities.json";

async function withProjectResourceIdentities(
	projectDir: string,
	definition: BindleDefinition,
): Promise<BindleDefinition> {
	let content: string;
	try {
		content = await readFile(
			path.join(projectDir, RESOURCE_IDENTITY_FILE),
			"utf8",
		);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") {
			return definition;
		}
		throw error;
	}
	let ledger: ResourceIdentityLedger;
	try {
		ledger = JSON.parse(content) as ResourceIdentityLedger;
	} catch {
		throw new TypeError(`invalid ${RESOURCE_IDENTITY_FILE}`);
	}
	return applyResourceIdentityLedger(definition, ledger);
}

export async function loadBindleDefinition(
	projectDir: string,
): Promise<BindleDefinition | null> {
	for (const candidate of BINDLE_SOURCE_CANDIDATES) {
		if (candidate === "dist/app.js") {
			const application = await loadTypeScriptHttpDefinition(projectDir);
			if (application)
				return withProjectResourceIdentities(projectDir, application);
		}
		const absolute = path.join(projectDir, candidate);
		if (!existsSync(absolute)) {
			continue;
		}

		type BindleModule = AppHttpModule & {
			bindle?: JsonValue;
		};
		let module: BindleModule;
		try {
			module = (await import(pathToFileURL(absolute).href)) as BindleModule;
		} catch (error) {
			if (isUncompiledTypeScript(candidate, error)) {
				continue;
			}
			throw new BindleImportError(absolute, error);
		}

		const definition = module.default ?? module.bindle;
		if (definition !== undefined && isBindleDefinition(definition))
			return withProjectResourceIdentities(projectDir, definition);
		if (candidate.includes("app.")) {
			const application = httpDefinitionFromModule(
				path.basename(projectDir),
				module,
			);
			if (application)
				return withProjectResourceIdentities(projectDir, application);
		}
	}

	return null;
}

function isUncompiledTypeScript<T>(candidate: string, error: T): boolean {
	if (!/\.(ts|mts)$/u.test(candidate)) return false;
	const message = error instanceof Error ? error.message : String(error);
	return /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension|\.ts['"]/u.test(
		message,
	);
}

function isBindleDefinition<T>(value: T): value is T & BindleDefinition {
	if (value === null || !isJsonObject(value)) {
		return false;
	}
	const candidate = value as {
		name?: JsonValue;
		resources?: JsonValue;
		edges?: JsonValue;
	};
	return (
		isJsonString(candidate.name) &&
		candidate.name.length > 0 &&
		candidate.resources !== null &&
		isJsonObject(candidate.resources) &&
		Array.isArray(candidate.edges)
	);
}

const COMPONENT_KINDS = new Set(["api", "web", "service"]);

interface DataParadigmMap {
	data: string;
	kv: string;
	bucket: string;
	queue: string;
	topic: string;
	secret: string;
}

function paradigmFor(kind: string): string {
	switch (kind) {
		case "data":
			return DATA_PARADIGM.data;
		case "kv":
			return DATA_PARADIGM.kv;
		case "bucket":
			return DATA_PARADIGM.bucket;
		case "queue":
			return DATA_PARADIGM.queue;
		case "topic":
			return DATA_PARADIGM.topic;
		case "secret":
			return DATA_PARADIGM.secret;
		default:
			return kind;
	}
}

const DATA_PARADIGM: DataParadigmMap = {
	data: "relational",
	kv: "key-value",
	bucket: "object",
	queue: "queue",
	topic: "topic",
	secret: "secret",
};

function environmentFromAnnotations(
	annotations: readonly ProviderAnnotation[],
): Record<string, string> {
	const entries: Array<[string, string]> = [];
	for (const annotation of annotations) {
		const values =
			annotation.option === "env"
				? annotation.config
				: annotation.option === "dependency" &&
						isJsonObject(annotation.config.env)
					? annotation.config.env
					: undefined;
		if (!values) continue;
		for (const [key, value] of Object.entries(values)) {
			if (isJsonString(value) || isJsonNumber(value) || isJsonBoolean(value)) {
				entries.push([key, String(value)]);
			}
		}
	}
	return Object.fromEntries(entries);
}

export function targetFromBindleDefinition(
	definition: BindleDefinition,
	componentHost: {
		readonly kind: string;
		readonly version: string;
	} = DEFAULT_COMPONENT_HOST,
): CollectionTarget {
	const delivery = evaluateBindingDeliveryGate({ definition });
	if (!delivery.ok) {
		throw new CollectionEngineError(
			"HOBO_BINDING_DELIVERY",
			`${delivery.summary}: ${delivery.reasons.map((reason) => reason.message).join("; ")}`,
		);
	}
	if (
		definition.deploymentIdentity !== undefined &&
		definition.deploymentIdentity !== "generated"
	) {
		throw new CollectionEngineError(
			"HOBO_RESOURCE_IDENTITY_INVALID",
			"unknown Bindle deployment identity mode",
		);
	}
	const resourceIds = new Map<string, string>();
	const allocatedIds = new Set<string>();
	for (const [alias, record] of Object.entries(definition.resources)) {
		const id =
			definition.deploymentIdentity === "generated"
				? record.generatedId
				: alias;
		const prefix = `res_${record.kind.replaceAll("-", "_")}_`;
		const validGenerated =
			id?.startsWith(prefix) &&
			/^\d{4,}$/u.test(id.slice(prefix.length)) &&
			Number(id.slice(prefix.length)) > 0;
		if (
			!id ||
			allocatedIds.has(id) ||
			(definition.deploymentIdentity === "generated" && !validGenerated)
		) {
			throw new CollectionEngineError(
				"HOBO_RESOURCE_IDENTITY_INVALID",
				`invalid resource identity for ${alias}`,
			);
		}
		resourceIds.set(alias, id);
		allocatedIds.add(id);
	}
	const resourceId = (alias: string): string => {
		const id = resourceIds.get(alias);
		if (!id) {
			throw new CollectionEngineError(
				"HOBO_RESOURCE_IDENTITY_INVALID",
				`unknown resource ${alias}`,
			);
		}
		return id;
	};
	const hasIdentityData = Object.values(definition.resources).every(
		(record) =>
			record.generatedId !== undefined &&
			record.identityOccurrence !== undefined,
	);
	return {
		bindleId: definition.name,
		componentHost,
		...(hasIdentityData
			? { identityLedger: resourceIdentityLedger(definition) }
			: undefined),
		dependencies: definition.edges
			.filter((edge) => !edge.to.startsWith("connector:"))
			.map((edge) => ({
				from: resourceId(edge.from),
				to: resourceId(edge.to),
			})),
		define(collect: CollectionContext): void {
			const backing = new Map<string, ReturnType<CollectionContext["data"]>>();

			for (const [name, record] of Object.entries(definition.resources)) {
				if (COMPONENT_KINDS.has(record.kind)) {
					continue;
				}
				const paradigm = paradigmFor(record.kind);
				const env = environmentFromAnnotations(record.annotations);
				const dependency = readDependencyConfig(record.annotations);
				const options = {
					paradigm,
					...(record.kind === "secret" && record.declaredAllow?.length
						? { allow: [...record.declaredAllow] }
						: undefined),
					...(Object.keys(env).length > 0 ? { env } : undefined),
					...(dependency && isJsonString(dependency.connectionString)
						? { connectionString: dependency.connectionString }
						: undefined),
					...(dependency && isJsonObject(dependency.endpoints)
						? { endpoints: dependency.endpoints }
						: undefined),
				};
				backing.set(name, collect.data(resourceId(name), options));
			}

			for (const [name, record] of Object.entries(definition.resources)) {
				if (!COMPONENT_KINDS.has(record.kind)) {
					continue;
				}
				const bind: Record<string, ReturnType<CollectionContext["data"]>> = {};
				for (const edge of definition.edges) {
					if (edge.from !== name) {
						continue;
					}
					const handle = backing.get(edge.to);
					if (handle && definition.resources[edge.to]?.kind !== "project") {
						bind[edge.to] = handle;
					}
				}
				const env = environmentFromAnnotations(record.annotations);
				collect.service(resourceId(name), {
					...(Object.keys(bind).length > 0 ? { bind } : undefined),
					...(Object.keys(env).length > 0 ? { env } : undefined),
				});
			}
		},
	};
}

export async function loadProjectCollectionTarget(
	projectDir: string,
): Promise<CollectionTarget | null> {
	const definition = await loadBindleDefinition(projectDir);
	return definition === null ? null : targetFromBindleDefinition(definition);
}

export async function compileProjectManifest(
	projectDir: string,
): Promise<ManifestV1 | null> {
	const target = await loadProjectCollectionTarget(projectDir);
	if (target === null) {
		return null;
	}
	try {
		return collectBindleManifest(target).manifest;
	} catch (error) {
		if (
			error instanceof CollectionEngineError &&
			error.code === "HOBO_BINDING_DELIVERY"
		) {
			throw error;
		}
		return null;
	}
}
