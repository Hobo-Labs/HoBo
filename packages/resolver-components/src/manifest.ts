// Component manifest: parse, don't validate. The wire form is
// `ResolverComponentManifestRecord` (data-models/resolver_components.proto,
// constrained by resolver_components.cue); this module parses it once into
// the frozen derived type `ComponentManifest` the host trusts, and computes
// the canonical digest the signed registry bundle binds.
import { createHash } from "node:crypto";
import { fromJson, toJson } from "@bufbuild/protobuf";
import { CD_DEFAULTS } from "@hobo/cd";
import {
	CAPABILITY_SLOTS,
	type CapabilitySlot,
	canonicalJson,
	type JsonValue,
} from "@hobo/core";
import {
	ReconcilerModeRecord,
	type ResolverComponentManifestRecord,
	ResolverComponentManifestRecordSchema,
} from "./_generated/resolver_components_pb.js";
import { ResolverComponentError } from "./errors.js";
import { RESOLVER_WIT_WORLD } from "./wit.js";

// public-contract: schema id of a component manifest document.
export const COMPONENT_MANIFEST_SCHEMA =
	"hobo.resolver-components.manifest/v1" as const;

export type ReconcilerMode = "conductor" | "agent";

// domain-view: parsed derived type; wire form is EgressHostRecord.
export interface ComponentEgressHost {
	readonly host: string;
	readonly ports: readonly string[];
	readonly pathPrefixes: readonly string[];
	readonly localAddresses: readonly string[];
}

// domain-view: parsed derived type; wire form is ResourceClassRecord.
export interface ComponentResourceClass {
	readonly productId: string;
	readonly slot: CapabilitySlot;
	readonly retainedFields: readonly string[];
	readonly observeFields: readonly string[];
	readonly directives: readonly string[];
}

// domain-view: parsed derived type; wire form is ComponentLimitsRecord (uint64 → number, capped).
export interface ComponentLimits {
	readonly memoryBytes: number;
	readonly callTimeoutMs: number;
	readonly fuel: number;
}

// domain-view: parsed derived type; wire form is ResolverComponentManifestRecord.
export interface ComponentManifest {
	readonly schema: typeof COMPONENT_MANIFEST_SCHEMA;
	readonly id: string;
	readonly version: string;
	readonly world: typeof RESOLVER_WIT_WORLD;
	readonly wasmDigest: string;
	readonly providerId: string;
	readonly classes: readonly ComponentResourceClass[];
	readonly egress: readonly ComponentEgressHost[];
	readonly credentialHosts: readonly string[];
	readonly limits: ComponentLimits;
	readonly modes: readonly ReconcilerMode[];
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u;
const PRODUCT_PATTERN = /^[a-z0-9][a-z0-9._/-]{0,127}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const HOST_PATTERN =
	/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const PORT_PATTERN = /^[0-9]{1,5}$/u;
const FIELD_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const DIRECTIVE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
/** Field names that read as secret material: never declared or reported. */
export const CREDENTIAL_FIELD_PATTERN =
	/(secret|password|token|credential|private[_-]?key|api[_-]?key)/iu;

function invalid(message: string, id?: string): ResolverComponentError {
	return new ResolverComponentError("component.manifest-invalid", message, id);
}

/** Parse an untrusted manifest document (protobuf JSON form). */
export function parseComponentManifest(input: JsonValue): ComponentManifest {
	let record: ResolverComponentManifestRecord;
	try {
		record = fromJson(ResolverComponentManifestRecordSchema, input);
	} catch (error) {
		throw invalid(
			`not a ResolverComponentManifestRecord: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	return fromRecord(record);
}

function fromRecord(
	record: ResolverComponentManifestRecord,
): ComponentManifest {
	const id = record.id;
	if (record.schema !== COMPONENT_MANIFEST_SCHEMA)
		throw invalid(`schema must be ${COMPONENT_MANIFEST_SCHEMA}`, id);
	if (!ID_PATTERN.test(id))
		throw invalid(`id ${JSON.stringify(id)} is not a component id`);
	if (!VERSION_PATTERN.test(record.version))
		throw invalid(
			`version ${JSON.stringify(record.version)} is not semver`,
			id,
		);
	if (record.world !== RESOLVER_WIT_WORLD)
		throw invalid(
			`world ${JSON.stringify(record.world)} is not ${RESOLVER_WIT_WORLD}`,
			id,
		);
	if (!DIGEST_PATTERN.test(record.wasmDigest))
		throw invalid("wasm_digest must be sha256:<64 hex>", id);
	if (!PRODUCT_PATTERN.test(record.providerId))
		throw invalid("provider_id must be a lowercase provider id", id);

	const modes = parseModes(record, id);
	const classes = parseClasses(record, id);
	const egress = parseEgress(record, id, modes);
	const credentialHosts = sortedUnique(record.credential?.hosts ?? []);
	const allowlisted = new Set(egress.map((entry) => entry.host));
	for (const host of credentialHosts) {
		if (!allowlisted.has(host))
			throw invalid(
				`credential host ${host} is not in the egress allowlist; a credential may only travel to an allowlisted host`,
				id,
			);
	}
	return Object.freeze({
		schema: COMPONENT_MANIFEST_SCHEMA,
		id,
		version: record.version,
		world: RESOLVER_WIT_WORLD,
		wasmDigest: record.wasmDigest,
		providerId: record.providerId,
		classes,
		egress,
		credentialHosts,
		limits: parseLimits(record, id),
		modes,
	});
}

function parseModes(
	record: ResolverComponentManifestRecord,
	id: string,
): readonly ReconcilerMode[] {
	const modes = new Set<ReconcilerMode>();
	for (const mode of record.modes) {
		if (mode === ReconcilerModeRecord.CONDUCTOR) modes.add("conductor");
		else if (mode === ReconcilerModeRecord.AGENT) modes.add("agent");
		else throw invalid("modes may name only CONDUCTOR or AGENT", id);
	}
	if (modes.size === 0) throw invalid("modes must name at least one mode", id);
	return Object.freeze([...modes].sort());
}

function parseClasses(
	record: ResolverComponentManifestRecord,
	id: string,
): readonly ComponentResourceClass[] {
	if (record.classes.length === 0)
		throw invalid("classes must declare at least one resource class", id);
	const seen = new Set<string>();
	const classes = record.classes.map((entry): ComponentResourceClass => {
		if (!PRODUCT_PATTERN.test(entry.productId))
			throw invalid(
				`product_id ${JSON.stringify(entry.productId)} is invalid`,
				id,
			);
		if (seen.has(entry.productId))
			throw invalid(`product ${entry.productId} is declared twice`, id);
		seen.add(entry.productId);
		const slot = CAPABILITY_SLOTS.find((candidate) => candidate === entry.slot);
		if (slot === undefined)
			throw invalid(
				`slot ${JSON.stringify(entry.slot)} is not one of ${CAPABILITY_SLOTS.join(", ")}`,
				id,
			);
		return Object.freeze({
			productId: entry.productId,
			slot,
			retainedFields: fieldList(entry.retainedFields, "retained_fields", id),
			observeFields: fieldList(entry.observeFields, "observe_fields", id),
			directives: directiveList(entry.directives, id),
		});
	});
	return Object.freeze(
		classes.sort((left, right) => compare(left.productId, right.productId)),
	);
}

function fieldList(
	fields: readonly string[],
	label: string,
	id: string,
): readonly string[] {
	for (const field of fields) {
		if (!FIELD_PATTERN.test(field))
			throw invalid(
				`${label} entry ${JSON.stringify(field)} is not a field path`,
				id,
			);
		if (CREDENTIAL_FIELD_PATTERN.test(field))
			throw invalid(
				`${label} entry ${JSON.stringify(field)} names credential material; records are secret-free (I9)`,
				id,
			);
	}
	return sortedUnique(fields);
}

function directiveList(
	fields: readonly string[],
	id: string,
): readonly string[] {
	for (const field of fields) {
		if (!DIRECTIVE_PATTERN.test(field))
			throw invalid(
				`directive ${JSON.stringify(field)} is not a parameter name`,
				id,
			);
	}
	return sortedUnique(fields);
}

function parseEgress(
	record: ResolverComponentManifestRecord,
	id: string,
	modes: readonly ReconcilerMode[],
): readonly ComponentEgressHost[] {
	if (record.egress.length > CD_DEFAULTS.componentMaxAllowlistHosts)
		throw invalid(
			`egress lists ${record.egress.length} hosts; the cap is ${CD_DEFAULTS.componentMaxAllowlistHosts}`,
			id,
		);
	const seen = new Set<string>();
	const hosts = record.egress.map((entry): ComponentEgressHost => {
		if (!HOST_PATTERN.test(entry.host))
			throw invalid(
				`egress host ${JSON.stringify(entry.host)} must be an exact lowercase host name (no wildcards, no IP literals)`,
				id,
			);
		if (/^[0-9.]+$/u.test(entry.host))
			throw invalid(
				`egress host ${entry.host} is an IP literal; name the host`,
				id,
			);
		if (seen.has(entry.host))
			throw invalid(`egress host ${entry.host} is listed twice`, id);
		seen.add(entry.host);
		for (const port of entry.ports) {
			const value = Number(port);
			if (!PORT_PATTERN.test(port) || value < 1 || value > 65_535)
				throw invalid(`egress port ${JSON.stringify(port)} is not a port`, id);
		}
		for (const prefix of entry.pathPrefixes) {
			if (!prefix.startsWith("/") || prefix.includes(".."))
				throw invalid(
					`path prefix ${JSON.stringify(prefix)} must start with / and hold no ..`,
					id,
				);
		}
		if (entry.localAddresses.length > 0 && !modes.includes("agent"))
			throw invalid(
				`egress host ${entry.host} lists local addresses, which only an agent-mode component may reach`,
				id,
			);
		return Object.freeze({
			host: entry.host,
			ports: sortedUnique(entry.ports),
			pathPrefixes: sortedUnique(
				entry.pathPrefixes.length === 0 ? ["/"] : entry.pathPrefixes,
			),
			localAddresses: sortedUnique(entry.localAddresses),
		});
	});
	return Object.freeze(
		hosts.sort((left, right) => compare(left.host, right.host)),
	);
}

function parseLimits(
	record: ResolverComponentManifestRecord,
	id: string,
): ComponentLimits {
	const limits = record.limits;
	const memoryBytes = capped(
		limits?.memoryBytes,
		CD_DEFAULTS.componentMemoryBytes,
		"memory_bytes",
		id,
	);
	const callTimeoutMs = capped(
		limits?.callTimeoutMs === undefined
			? undefined
			: BigInt(limits.callTimeoutMs),
		CD_DEFAULTS.componentCallTimeoutMs,
		"call_timeout_ms",
		id,
	);
	const fuel = capped(limits?.fuel, CD_DEFAULTS.componentFuel, "fuel", id);
	return Object.freeze({ memoryBytes, callTimeoutMs, fuel });
}

function capped(
	value: bigint | undefined,
	cap: number,
	label: string,
	id: string,
): number {
	if (value === undefined || value === 0n) return cap;
	if (value > BigInt(cap))
		throw invalid(
			`limits.${label} ${value} exceeds the CD_DEFAULTS cap ${cap}`,
			id,
		);
	return Number(value);
}

/** Canonical content digest of a parsed manifest (what the bundle binds). */
export function componentManifestDigest(manifest: ComponentManifest): string {
	const record = fromJson(ResolverComponentManifestRecordSchema, {
		schema: manifest.schema,
		id: manifest.id,
		version: manifest.version,
		world: manifest.world,
		wasmDigest: manifest.wasmDigest,
		providerId: manifest.providerId,
		classes: manifest.classes.map((entry) => ({
			productId: entry.productId,
			slot: entry.slot,
			retainedFields: [...entry.retainedFields],
			observeFields: [...entry.observeFields],
			directives: [...entry.directives],
		})),
		egress: manifest.egress.map((entry) => ({
			host: entry.host,
			ports: [...entry.ports],
			pathPrefixes: [...entry.pathPrefixes],
			localAddresses: [...entry.localAddresses],
		})),
		credential: { hosts: [...manifest.credentialHosts] },
		limits: {
			memoryBytes: String(manifest.limits.memoryBytes),
			callTimeoutMs: manifest.limits.callTimeoutMs,
			fuel: String(manifest.limits.fuel),
		},
		modes: manifest.modes.map((mode) =>
			mode === "agent"
				? "RECONCILER_MODE_RECORD_AGENT"
				: "RECONCILER_MODE_RECORD_CONDUCTOR",
		),
	});
	const canonical = canonicalJson(
		toJson(ResolverComponentManifestRecordSchema, record),
	);
	return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function sortedUnique(values: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(values)].sort(compare));
}

/** Code-unit comparison: locale-independent so ordering is reproducible. */
export function compare(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
