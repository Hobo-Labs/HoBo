import { createHash } from "node:crypto";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: schema id every ingestable bundle manifest must carry.
export const BUNDLE_MANIFEST_SCHEMA = "hobo.registry.bundle-manifest/v1";

// public-contract: fact type appended when a bundle manifest ingests.
export const REGISTRY_BUNDLE_IMPORTED = "registry.BundleImported";

export type IngestErrorCode =
	| "not-an-object"
	| "unsupported-schema"
	| "missing-name"
	| "missing-version"
	| "missing-provider"
	| "invalid-capabilities";

export interface IngestError {
	code: IngestErrorCode;
	path: string;
	message: string;
}

// domain-view: parsed derived type of data-models BundleCapability
export interface BundleCapability {
	port: string;
	features: readonly string[];
}

// domain-view: parsed derived type of data-models BundleManifest
export interface BundleManifest {
	schema: typeof BUNDLE_MANIFEST_SCHEMA;
	name: string;
	version: string;
	provider: string;
	capabilities: readonly BundleCapability[];
	description: string;
}

export interface BundleImportedFact {
	type: typeof REGISTRY_BUNDLE_IMPORTED;
	data: {
		schema: typeof BUNDLE_MANIFEST_SCHEMA;
		name: string;
		version: string;
		provider: string;
		ports: readonly string[];
		manifestDigest: string;
	};
}

export type IngestResult =
	| { ok: true; manifest: BundleManifest; fact: BundleImportedFact }
	| { ok: false; errors: IngestError[] };

export function bundleManifestDigest(manifest: BundleManifest): string {
	const canonical = {
		schema: manifest.schema,
		name: manifest.name,
		version: manifest.version,
		provider: manifest.provider,
		capabilities: [...manifest.capabilities]
			.map((capability) => ({
				port: capability.port,
				features: [...capability.features].sort(),
			}))
			.sort((a, b) => (a.port < b.port ? -1 : a.port > b.port ? 1 : 0)),
		description: manifest.description,
	};
	const digest = createHash("sha256")
		.update(JSON.stringify(canonical))
		.digest("hex");
	return `sha256:${digest}`;
}

function nonEmptyString(value: JsonValue | undefined): value is string {
	return isJsonString(value) && value.length > 0;
}

function parseCapabilities(
	raw: JsonValue | undefined,
	errors: IngestError[],
): BundleCapability[] {
	if (raw === undefined) return [];
	if (!Array.isArray(raw)) {
		errors.push({
			code: "invalid-capabilities",
			path: "capabilities",
			message: "capabilities must be an array when present",
		});
		return [];
	}
	const parsed: BundleCapability[] = [];
	for (const [index, entry] of raw.entries()) {
		if (entry === null || !isJsonObject(entry)) {
			errors.push({
				code: "invalid-capabilities",
				path: `capabilities[${index}]`,
				message: "capability must be an object",
			});
			continue;
		}
		const record = entry as JsonObject;
		if (!nonEmptyString(record.port)) {
			errors.push({
				code: "invalid-capabilities",
				path: `capabilities[${index}].port`,
				message: "capability port must be a non-empty string",
			});
			continue;
		}
		const features = Array.isArray(record.features)
			? record.features.filter(nonEmptyString)
			: [];
		parsed.push({ port: record.port, features });
	}
	return parsed;
}

export function ingestBundleManifest(raw: JsonValue): IngestResult {
	if (raw === null || !isJsonObject(raw) || Array.isArray(raw)) {
		return {
			ok: false,
			errors: [
				{
					code: "not-an-object",
					path: "",
					message: "bundle manifest must be a JSON object",
				},
			],
		};
	}
	const record = raw as JsonObject;
	const errors: IngestError[] = [];

	if (record.schema !== BUNDLE_MANIFEST_SCHEMA) {
		errors.push({
			code: "unsupported-schema",
			path: "schema",
			message: `schema must be ${BUNDLE_MANIFEST_SCHEMA}`,
		});
	}
	if (!nonEmptyString(record.name)) {
		errors.push({
			code: "missing-name",
			path: "name",
			message: "name must be a non-empty string",
		});
	}
	if (!nonEmptyString(record.version)) {
		errors.push({
			code: "missing-version",
			path: "version",
			message: "version must be a non-empty string",
		});
	}
	if (!nonEmptyString(record.provider)) {
		errors.push({
			code: "missing-provider",
			path: "provider",
			message: "provider must be a non-empty string",
		});
	}
	const capabilities = parseCapabilities(record.capabilities, errors);
	if (errors.length > 0) return { ok: false, errors };

	const manifest: BundleManifest = {
		schema: BUNDLE_MANIFEST_SCHEMA,
		name: record.name as string,
		version: record.version as string,
		provider: record.provider as string,
		capabilities,
		description: isJsonString(record.description) ? record.description : "",
	};
	const manifestDigest = bundleManifestDigest(manifest);
	return {
		ok: true,
		manifest,
		fact: {
			type: REGISTRY_BUNDLE_IMPORTED,
			data: {
				schema: manifest.schema,
				name: manifest.name,
				version: manifest.version,
				provider: manifest.provider,
				ports: [...new Set(capabilities.map((c) => c.port))].sort(),
				manifestDigest,
			},
		},
	};
}
