import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
	type BindleDefinition,
	type CollectionContext,
	type CollectionTarget,
	collectBindleManifest,
	type ManifestV1,
	readCadence,
} from "@hobo/bindles";
import { isJsonObject, isJsonString, type JsonValue } from "../json.js";
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

export async function loadBindleDefinition(
	projectDir: string,
): Promise<BindleDefinition | null> {
	for (const candidate of BINDLE_SOURCE_CANDIDATES) {
		if (candidate === "dist/app.js") {
			const application = await loadTypeScriptHttpDefinition(projectDir);
			if (application) return application;
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
			return definition;
		if (candidate.includes("app.")) {
			const application = httpDefinitionFromModule(
				path.basename(projectDir),
				module,
			);
			if (application) return application;
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

export function targetFromBindleDefinition(
	definition: BindleDefinition,
	componentHost: {
		readonly kind: string;
		readonly version: string;
	} = DEFAULT_COMPONENT_HOST,
): CollectionTarget {
	return {
		bindleId: definition.name,
		componentHost,
		dependencies: definition.edges.filter(
			(edge) => !edge.to.startsWith("connector:"),
		),
		define(collect: CollectionContext): void {
			const backing = new Map<string, ReturnType<CollectionContext["data"]>>();

			for (const [name, record] of Object.entries(definition.resources)) {
				if (COMPONENT_KINDS.has(record.kind)) {
					continue;
				}
				const paradigm = paradigmFor(record.kind);
				const cron = readCadence(record.annotations);
				const options = {
					paradigm,
					...(record.kind === "secret" && record.declaredAllow?.length
						? { allow: [...record.declaredAllow] }
						: undefined),
					...(cron !== undefined
						? { annotations: { cadence: cron } }
						: undefined),
				};
				backing.set(name, collect.data(name, options));
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
				collect.service(name, Object.keys(bind).length > 0 ? { bind } : {});
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
	} catch {
		return null;
	}
}
