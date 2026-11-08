import { createHash } from "node:crypto";
import { parseBudgetPolicy } from "@hobo/core";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

// public-contract: manifest discriminator included in canonical deployment hashes.
export const MANIFEST_SCHEMA = "hobo.manifest/v1" as const;

const RESOURCE_TYPES = new Set(["data.v1", "component.v1", "website.v1"]);
const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MANIFEST_REFERENCE =
	/^\{([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;
const RESOURCE_PLACEHOLDER =
	/^\$\{resources\.([A-Za-z][A-Za-z0-9_-]*)\.([A-Za-z][A-Za-z0-9_-]*)#([A-Za-z][A-Za-z0-9_-]*)\.outputs\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;
const CONTEXT_PLACEHOLDER = /^\$\{context\.([A-Za-z][A-Za-z0-9_.-]*)\}$/;

const manifestV1Brand = Symbol("ManifestV1");

export type ManifestHash = `sha256:${string}`;

export type ManifestReference = {
	readonly resourceId: string;
	readonly output: string;
};

export type OutputPlaceholder =
	| {
			readonly type: string;
			readonly className: string;
			readonly resourceId: string;
			readonly output: string;
	  }
	| {
			readonly contextPath: string;
	  };

export type ManifestV1 = {
	readonly brand: typeof manifestV1Brand;
	readonly value: Readonly<ManifestRecord>;
};

type ManifestRecord = {
	schema: typeof MANIFEST_SCHEMA;
	componentHost: {
		kind: string;
		version: string;
	};
	resources: Record<string, ResourceRecord>;
	triggerEdges?: TriggerEdgeRecord[];
	/** Scope policy is part of the canonical deployment input and hash. */
	policy?: JsonObject;
};

type ResourceRecord = {
	type: string;
	port?: string;
	paradigm?: string;
	allow?: string[];
	connectionString?: string;
	image?: string;
	runtime?: string;
	exports?: string[];
	links?: LinkRecord[];
	endpoints?: JsonObject;
	env?: Record<string, string>;
	annotations?: JsonObject;
	bind?: string[];
};

type LinkRecord = {
	import: string;
	to: string;
};

type TriggerEdgeRecord = {
	id: string;
	kind: string;
	resourceId: string;
	exportInterface: string;
	event?: string;
};

export class ManifestParseError extends Error {
	readonly path: string;

	constructor(path: string, message: string) {
		super(`${path}: ${message}`);
		this.name = "ManifestParseError";
		this.path = path;
	}
}

export function parseManifest<T>(input: T): ManifestV1 {
	const record = parseManifestRecord(cloneAsJson(input));
	return brandManifest(record);
}

export function serializeManifest(manifest: ManifestV1): string {
	return JSON.stringify(sortKeys(manifest.value));
}

export function canonicalManifestHash(manifest: ManifestV1): ManifestHash {
	const canonical = serializeManifest(manifest);
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

export function parseManifestReference(value: string): ManifestReference {
	const match = MANIFEST_REFERENCE.exec(value);
	if (!match) {
		throw new ManifestParseError(
			"reference",
			`invalid manifest token ${value}`,
		);
	}

	return {
		resourceId: capture(match, 1, "reference.resourceId"),
		output: capture(match, 2, "reference.output"),
	};
}

export function parseOutputPlaceholder(value: string): OutputPlaceholder {
	const resourceMatch = RESOURCE_PLACEHOLDER.exec(value);
	if (resourceMatch) {
		return {
			type: capture(resourceMatch, 1, "placeholder.type"),
			className: capture(resourceMatch, 2, "placeholder.className"),
			resourceId: capture(resourceMatch, 3, "placeholder.resourceId"),
			output: capture(resourceMatch, 4, "placeholder.output"),
		};
	}

	const contextMatch = CONTEXT_PLACEHOLDER.exec(value);
	if (contextMatch) {
		return {
			contextPath: capture(contextMatch, 1, "placeholder.contextPath"),
		};
	}

	throw new ManifestParseError("placeholder", `invalid placeholder ${value}`);
}

function capture(match: RegExpExecArray, index: number, path: string): string {
	const value = match[index];
	if (value === undefined || value.length === 0) {
		throw new ManifestParseError(path, "missing capture");
	}
	return value;
}

export interface AspireFallbackEnv {
	[id: string]: string[];
}

export function aspireFallbackEnv(manifest: ManifestV1): AspireFallbackEnv {
	const aspireEnv: AspireFallbackEnv = {};

	for (const [id, resource] of Object.entries(manifest.value.resources)) {
		if (!isRecord(resource.env)) {
			continue;
		}

		for (const key of Object.keys(resource.env)) {
			if (
				key.startsWith("ConnectionStrings__") ||
				key.startsWith("services__")
			) {
				aspireEnv[id] ??= [];
				aspireEnv[id].push(key);
			}
		}
	}

	return aspireEnv;
}

function parseManifestRecord(input: JsonValue): ManifestRecord {
	assertRecord(input, "manifest");

	if (input.schema !== MANIFEST_SCHEMA) {
		throw new ManifestParseError("schema", `expected ${MANIFEST_SCHEMA}`);
	}

	assertRecord(input.componentHost, "componentHost");
	assertRequiredString(input.componentHost.kind, "componentHost.kind");
	assertRequiredString(input.componentHost.version, "componentHost.version");

	assertRecord(input.resources, "resources");

	const resourceEntries = Object.entries(input.resources);
	if (resourceEntries.length === 0) {
		throw new ManifestParseError(
			"resources",
			"must declare at least one resource",
		);
	}

	const resources: Record<string, ResourceRecord> = {};
	for (const [id, resource] of resourceEntries) {
		resources[id] = validateResource(id, resource);
	}

	const aspireScratch: Record<string, string[]> = {};
	for (const [id, resource] of Object.entries(resources)) {
		validateResourceReferences(id, resource, resources, aspireScratch);
	}

	let triggerEdges: TriggerEdgeRecord[] | undefined;
	if (input.triggerEdges !== undefined) {
		if (!Array.isArray(input.triggerEdges)) {
			throw new ManifestParseError("triggerEdges", "must be an array");
		}
		triggerEdges = input.triggerEdges.map((edge, index) =>
			validateTriggerEdge(edge, `triggerEdges[${index}]`, resources),
		);
	}
	if (input.policy !== undefined) {
		assertRecord(input.policy, "policy");
		validateBudgetPolicy(input.policy, "policy");
	}

	return {
		schema: MANIFEST_SCHEMA,
		componentHost: {
			kind: input.componentHost.kind,
			version: input.componentHost.version,
		},
		resources,
		...(triggerEdges ? { triggerEdges } : undefined),
		...(input.policy !== undefined
			? { policy: structuredClone(input.policy) }
			: undefined),
	};
}

function validateBudgetPolicy(policy: JsonObject, path: string): void {
	if (policy.budgetPolicy === undefined) return;
	try {
		parseBudgetPolicy(policy.budgetPolicy);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		throw new ManifestParseError(`${path}.budgetPolicy`, error.message);
	}
}

function validateResource(
	id: string,
	resource: JsonValue | undefined,
): ResourceRecord {
	if (!RESOURCE_ID.test(id)) {
		throw new ManifestParseError(`resources.${id}`, "invalid resource id");
	}
	assertRecord(resource, `resources.${id}`);
	if (resource.policy !== undefined) {
		assertRecord(resource.policy, `resources.${id}.policy`);
		validateBudgetPolicy(resource.policy, `resources.${id}.policy`);
		if (resource.policy.budgetPolicy !== undefined)
			throw new ManifestParseError(
				`resources.${id}.policy.budgetPolicy`,
				"shared budget policy must be declared at manifest.policy.budgetPolicy",
			);
	}

	assertRequiredString(resource.type, `resources.${id}.type`);
	if (!RESOURCE_TYPES.has(resource.type)) {
		throw new ManifestParseError(
			`resources.${id}.type`,
			`unknown resource type ${resource.type}`,
		);
	}

	if (resource.type === "data.v1") {
		assertRequiredString(resource.port, `resources.${id}.port`);
	}

	if (resource.allow !== undefined && !isStringArray(resource.allow)) {
		throw new ManifestParseError(
			`resources.${id}.allow`,
			"must be an array of strings",
		);
	}

	if (resource.links !== undefined && !Array.isArray(resource.links)) {
		throw new ManifestParseError(`resources.${id}.links`, "must be an array");
	}

	if (resource.bind !== undefined && !isStringArray(resource.bind)) {
		throw new ManifestParseError(
			`resources.${id}.bind`,
			"must be an array of resource ids",
		);
	}

	// SAFETY: assertion required at this I/O or test boundary.
	return structuredClone(resource) as ResourceRecord;
}

function validateTriggerEdge(
	edge: JsonValue | undefined,
	path: string,
	resources: Record<string, ResourceRecord>,
): TriggerEdgeRecord {
	assertRecord(edge, path);
	assertRequiredString(edge.id, `${path}.id`);
	assertRequiredString(edge.kind, `${path}.kind`);
	assertRequiredString(edge.resourceId, `${path}.resourceId`);
	assertRequiredString(edge.exportInterface, `${path}.exportInterface`);

	if (!resources[edge.resourceId]) {
		throw new ManifestParseError(
			`${path}.resourceId`,
			`unknown resource ${edge.resourceId}`,
		);
	}

	return {
		id: edge.id,
		kind: edge.kind,
		resourceId: edge.resourceId,
		exportInterface: edge.exportInterface,
		...(isJsonString(edge.event) ? { event: edge.event } : undefined),
	};
}

function validateResourceReferences(
	id: string,
	resource: ResourceRecord,
	resources: Record<string, ResourceRecord>,
	aspireEnv: Record<string, string[]>,
): void {
	if (resource.links) {
		resource.links.forEach((link, index) => {
			assertRecord(link, `resources.${id}.links[${index}]`);
			assertRequiredString(
				link.import,
				`resources.${id}.links[${index}].import`,
			);
			assertRequiredString(link.to, `resources.${id}.links[${index}].to`);

			const target = resources[link.to];
			if (!target) {
				throw new ManifestParseError(
					`resources.${id}.links[${index}].to`,
					`unknown resource ${link.to}`,
				);
			}

			if (target.port !== link.import) {
				throw new ManifestParseError(
					`resources.${id}.links[${index}].import`,
					`no matching declared resource for ${link.import}`,
				);
			}
		});
	}

	if (resource.bind) {
		for (const targetId of resource.bind) {
			if (!resources[targetId]) {
				throw new ManifestParseError(
					`resources.${id}.bind`,
					`unknown resource ${targetId}`,
				);
			}
		}
	}

	visitStrings(resource, `resources.${id}`, (value, visitPath) => {
		if (MANIFEST_REFERENCE.test(value)) {
			const reference = parseManifestReference(value);
			if (!resources[reference.resourceId]) {
				throw new ManifestParseError(
					visitPath,
					`unknown resource ${reference.resourceId}`,
				);
			}
		}

		if (value.startsWith("${")) {
			const placeholder = parseOutputPlaceholder(value);
			if ("resourceId" in placeholder && !resources[placeholder.resourceId]) {
				throw new ManifestParseError(
					visitPath,
					`unknown resource ${placeholder.resourceId}`,
				);
			}
		}
	});

	if (isRecord(resource.env)) {
		for (const key of Object.keys(resource.env)) {
			if (
				key.startsWith("ConnectionStrings__") ||
				key.startsWith("services__")
			) {
				aspireEnv[id] ??= [];
				aspireEnv[id].push(key);
			}
		}
	}
}

function visitStrings<T>(
	value: T,
	path: string,
	visitor: (value: string, path: string) => void,
): void {
	if (isJsonString(value)) {
		visitor(value, path);
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => {
			visitStrings(item, `${path}[${index}]`, visitor);
		});
		return;
	}
	if (isRecord(value)) {
		for (const [key, child] of Object.entries(value)) {
			visitStrings(child, `${path}.${key}`, visitor);
		}
	}
}

function sortKeys<T>(value: T): JsonValue {
	const json = cloneAsJson(value);
	if (Array.isArray(json)) {
		return json.map(sortKeys);
	}
	if (!isRecord(json)) {
		return json;
	}

	return Object.fromEntries(
		Object.keys(json)
			.sort()
			.map((key) => [key, sortKeys(json[key] ?? null)]),
	);
}

function brandManifest(record: ManifestRecord): ManifestV1 {
	return {
		brand: manifestV1Brand,
		// SAFETY: assertion required at this I/O or test boundary.
		value: Object.freeze(structuredClone(record)) as ManifestRecord,
	};
}

function assertRecord(
	value: JsonValue | undefined,
	path: string,
): asserts value is JsonObject {
	if (!isRecord(value)) {
		throw new ManifestParseError(path, "must be an object");
	}
}

function assertRequiredString(
	value: JsonValue | undefined,
	path: string,
): asserts value is string {
	if (!isJsonString(value) || value.length === 0) {
		throw new ManifestParseError(path, "required");
	}
}

function isRecord<T>(value: T): value is T & JsonObject {
	return isJsonObject(value) && !Array.isArray(value);
}

function isStringArray<T>(value: T): value is T & string[] {
	return Array.isArray(value) && value.every((item) => isJsonString(item));
}
