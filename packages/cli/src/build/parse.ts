import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";
import type { CliFlags } from "../shell/parse.js";
import type { CliContext } from "../types/envelope.js";
import { BuildError } from "./errors.js";

// public-contract: the manifest's `schema` version discriminator — the constant is the contract.
export const BUILD_MANIFEST_SCHEMA = "hobo.build-manifest/v1" as const;
const DEFAULT_SOURCE_DATE_EPOCH = "2026-01-01T00:00:00.000Z";

export type ArtifactKind = "wasm-component" | "oci-container" | "node-app";

// domain-view: parsed CLI-facing type (string unions, branded ids, literal fields); the package's data-models/*.proto is its wire contract (technical-standards.md).
export type ServiceDeclaration = {
	readonly name: string;
	readonly language: string;
	readonly runtime: "wasm" | "component" | "container";
	readonly sourceRoot: string;
	readonly entrypoint: string;
};

// domain-view: parsed CLI-facing type (string unions, branded ids, literal fields); the package's data-models/*.proto is its wire contract (technical-standards.md).
export type BuildArtifact = {
	readonly service: string;
	readonly kind: ArtifactKind;
	readonly path: string;
	readonly mediaType: string;
	readonly digest: string;
	readonly runtime: string;
	readonly witWorld?: string;
	readonly fallbackReason?: string;
	readonly source: string;
};

// domain-view: parsed CLI-facing type (string unions, branded ids, literal fields); the package's data-models/*.proto is its wire contract (technical-standards.md).
export type BuildManifest = {
	readonly schema: typeof BUILD_MANIFEST_SCHEMA;
	readonly generatedBy: "hobo build";
	readonly runtimeTarget: TargetRuntime;
	readonly sourceDateEpoch: string;
	readonly artifacts: readonly BuildArtifact[];
};

export type TargetRuntime = "auto" | "wasm" | "container";

export type BuildRequest = {
	readonly json: boolean;
	readonly projectRoot: string;
	readonly targetRuntime: TargetRuntime;
	readonly sourceDateEpoch: string;
};

export type BuildResult = {
	readonly manifest: string;
	readonly manifestDigest: string;
	readonly artifacts: readonly BuildArtifact[];
};

export function parseBuildRequestFromInvocation(
	context: CliContext,
	flags: CliFlags,
	env: NodeJS.ProcessEnv,
): BuildRequest {
	const runtime = flags.runtime ?? flags.target ?? env.HOBO_RUNTIME ?? "auto";
	return {
		json: flags.json,
		projectRoot: context.projectDir ?? context.cwd,
		targetRuntime: normalizeTargetRuntime(runtime),
		sourceDateEpoch: env.SOURCE_DATE_EPOCH ?? DEFAULT_SOURCE_DATE_EPOCH,
	};
}

export function parseServiceDeclaration(raw: JsonValue): ServiceDeclaration {
	if (!raw || !isJsonObject(raw)) {
		throw new BuildError(
			"HOBO_BUILD_SERVICE_INVALID",
			"Service declaration must be an object.",
		);
	}

	const record = raw as JsonObject;
	const name = String(record.name ?? "");
	if (!/^[a-z][a-z0-9-]*$/u.test(name)) {
		throw new BuildError(
			"HOBO_BUILD_SERVICE_INVALID",
			`Invalid service name "${name}".`,
			{
				service: name,
			},
		);
	}

	const entrypoint = normalizePath(
		String(record.entrypoint ?? defaultEntrypoint(record, name)),
	);
	const sourceRoot = normalizePath(
		String(record.sourceRoot ?? dirnameOf(entrypoint)),
	);
	assertRelativePath(sourceRoot, "sourceRoot");
	assertRelativePath(entrypoint, "entrypoint");

	return {
		name,
		language: normalizeLanguage(
			String(record.language ?? inferLanguage(entrypoint)),
		),
		runtime: normalizeServiceRuntime(String(record.runtime ?? "wasm")),
		sourceRoot,
		entrypoint,
	};
}

export function parseBuildManifest(json: JsonValue): BuildManifest {
	if (!json || !isJsonObject(json)) {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			"Build manifest must be an object.",
		);
	}

	const record = json as JsonObject;
	if (record.schema !== BUILD_MANIFEST_SCHEMA) {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			`Unexpected manifest schema "${String(record.schema)}".`,
		);
	}

	const artifacts = Array.isArray(record.artifacts)
		? record.artifacts.map((artifact) => parseBuildArtifact(artifact))
		: [];

	return {
		schema: BUILD_MANIFEST_SCHEMA,
		generatedBy: "hobo build",
		runtimeTarget: normalizeTargetRuntime(
			String(record.runtimeTarget ?? "auto"),
		),
		sourceDateEpoch: String(
			record.sourceDateEpoch ?? DEFAULT_SOURCE_DATE_EPOCH,
		),
		artifacts,
	};
}

function parseBuildArtifact(raw: JsonValue): BuildArtifact {
	if (!raw || !isJsonObject(raw)) {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			"Build artifact must be an object.",
		);
	}

	const record = raw as JsonObject;
	const kind = String(record.kind ?? "");
	if (
		kind !== "wasm-component" &&
		kind !== "oci-container" &&
		kind !== "node-app"
	) {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			`Invalid artifact kind "${kind}".`,
		);
	}
	if (kind === "node-app" && record.runtime !== "node") {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			"Node app artifacts require runtime node.",
		);
	}

	const digest = String(record.digest ?? "");
	if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			`Invalid artifact digest "${digest}".`,
		);
	}

	const path = normalizePath(String(record.path ?? ""));
	assertRelativePath(path, "path");

	const fallbackReason =
		record.fallbackReason !== undefined
			? String(record.fallbackReason)
			: undefined;
	if (kind === "oci-container" && !fallbackReason) {
		throw new BuildError(
			"HOBO_BUILD_SOURCE_PARSE",
			"OCI fallback artifacts require fallbackReason.",
		);
	}

	const artifact: BuildArtifact = {
		service: String(record.service ?? ""),
		kind,
		path,
		mediaType: String(record.mediaType ?? ""),
		digest,
		runtime: String(record.runtime ?? ""),
		source: normalizePath(String(record.source ?? "")),
	};

	if (record.witWorld !== undefined) {
		return { ...artifact, witWorld: String(record.witWorld) };
	}
	if (fallbackReason !== undefined) {
		return { ...artifact, fallbackReason };
	}
	return artifact;
}

function normalizeLanguage(language: string): string {
	const normalized = language.toLowerCase();
	if (normalized === "typescript") return "ts";
	if (normalized === "javascript") return "js";
	if (normalized === "py") return "python";
	return normalized;
}

function inferLanguage(entrypoint: string): string {
	const dot = entrypoint.lastIndexOf(".");
	const extension = dot < 0 ? "" : entrypoint.slice(dot).toLowerCase();
	if (extension === ".ts") return "ts";
	if (extension === ".js") return "js";
	if (extension === ".py") return "python";
	return extension.replace(/^\./, "") || "unknown";
}

function normalizeServiceRuntime(
	runtime: string,
): ServiceDeclaration["runtime"] {
	const normalized = runtime.toLowerCase();
	if (
		normalized === "wasm" ||
		normalized === "component" ||
		normalized === "container"
	) {
		return normalized === "component" ? "wasm" : normalized;
	}
	throw new BuildError(
		"HOBO_BUILD_RUNTIME_INVALID",
		`Invalid service runtime "${runtime}".`,
		{
			runtime,
		},
	);
}

export function normalizeTargetRuntime(runtime: string): TargetRuntime {
	const normalized = runtime.toLowerCase();
	if (
		normalized === "auto" ||
		normalized === "wasm" ||
		normalized === "component" ||
		normalized === "container"
	) {
		return normalized === "component" ? "wasm" : (normalized as TargetRuntime);
	}
	throw new BuildError(
		"HOBO_BUILD_RUNTIME_INVALID",
		`Invalid build runtime "${runtime}".`,
		{
			runtime,
		},
	);
}

function assertRelativePath(path: string, label: string): void {
	if (
		path.startsWith("/") ||
		/^[A-Za-z]:/.test(path) ||
		path.split("/").includes("..")
	) {
		throw new BuildError(
			"HOBO_BUILD_PATH_INVALID",
			`Service ${label} must stay inside the project.`,
			{
				[label]: path,
			},
		);
	}
}

function defaultEntrypoint(record: JsonObject, name: string): string {
	const language = normalizeLanguage(String(record.language ?? "ts"));
	const file = language === "python" ? "app.py" : "service.ts";
	return `services/${name}/src/${file}`;
}

function dirnameOf(path: string): string {
	const index = path.lastIndexOf("/");
	return index >= 0 ? path.slice(0, index) : path;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//u, "");
}
