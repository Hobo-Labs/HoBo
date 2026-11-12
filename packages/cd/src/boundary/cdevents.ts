// CDEvents (pinned spec, see STANDARDS.lock.json) as plain data: the event
// shape, the pinned type ids, deterministic ids, purls and the structural
// check every projected event passes before it may leave the process.
//
// Pure: no clock, no randomness, no I/O. Ids are hashes of the journal fact
// that produced the event, so a replay emits byte-identical CDEvents (I8).

import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@hobo/core";
import { BoundaryError } from "./errors.js";
import { isJsonObject, isJsonString } from "./json.js";

// public-contract: the pinned CDEvents release (Part I §I.8 R8).
export const CDEVENTS_SPEC = Object.freeze({
	tag: "v0.5.1",
	specversion: "0.5.1",
} as const);

// public-contract: pinned CDEvents type ids (spec v0.5.1).
export const CDEVENT_TYPES = Object.freeze({
	artifactPublished: "dev.cdevents.artifact.published.0.3.0",
	serviceDeployed: "dev.cdevents.service.deployed.0.3.0",
	serviceUpgraded: "dev.cdevents.service.upgraded.0.3.0",
	serviceRolledback: "dev.cdevents.service.rolledback.0.3.0",
	serviceRemoved: "dev.cdevents.service.removed.0.3.0",
	environmentCreated: "dev.cdevents.environment.created.0.3.0",
	environmentModified: "dev.cdevents.environment.modified.0.3.0",
	environmentDeleted: "dev.cdevents.environment.deleted.0.3.0",
} as const);

export type StandardCdEventType =
	(typeof CDEVENT_TYPES)[keyof typeof CDEVENT_TYPES];

// public-contract: version of every HoBo custom event body.
export const HOBO_CUSTOM_EVENT_VERSION = "0.1.0" as const;
// public-contract: custom event namespace prefix (tool `hobo`).
export const HOBO_CUSTOM_EVENT_PREFIX = "dev.cdeventsx.hobo-" as const;

/** `dev.cdeventsx.hobo-<subject>.<predicate>.0.1.0`, the spec's custom form. */
export function hoboEventType(subject: string, predicate: string): string {
	if (
		!/^[a-z][a-z0-9]*$/u.test(subject) ||
		!/^[a-z][a-z0-9]*$/u.test(predicate)
	) {
		throw new BoundaryError(
			"cdevent-invalid",
			`custom subject/predicate must be lowercase alphanumerics: ${subject}.${predicate}`,
		);
	}
	return `${HOBO_CUSTOM_EVENT_PREFIX}${subject}.${predicate}.${HOBO_CUSTOM_EVENT_VERSION}`;
}

export type CdEventContext = Readonly<{
	specversion: string;
	id: string;
	source: string;
	type: string;
	timestamp: string;
	chainId?: string;
	schemaUri?: string;
}>;

export type CdEventSubject = Readonly<{
	id: string;
	source?: string;
	content: JsonObject;
}>;

/** One CDEvent, exactly as it is serialized onto the wire. */
export type CdEvent = Readonly<{
	context: CdEventContext;
	subject: CdEventSubject;
	customData?: JsonObject;
	customDataContentType?: string;
}>;

/** Canonical JSON: object keys sorted, no insignificant whitespace. */
export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	}
	if (isJsonObject(value)) {
		const entries = Object.keys(value)
			.sort()
			.filter((key) => value[key] !== undefined)
			.map(
				(key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`,
			);
		return `{${entries.join(",")}}`;
	}
	return JSON.stringify(value);
}

export function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * Deterministic CDEvent id: a UUID-shaped rendering of
 * sha256(sourceEventId / type / discriminator). The same journal fact always
 * yields the same id, so a receiver can de-duplicate at-least-once delivery.
 */
export function cdEventId(
	sourceEventId: string,
	type: string,
	discriminator = "",
): string {
	const h = sha256Hex(`${sourceEventId}/${type}/${discriminator}`);
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Package URL for an artifact: its own purl coordinate, else derived. */
export function artifactPurl(input: {
	readonly name: string;
	readonly digest: string;
	readonly ecosystem?: string;
	readonly coordinate?: string;
}): string {
	if (input.coordinate?.startsWith("pkg:")) return input.coordinate;
	const name = encodeURIComponent(input.name || "artifact");
	const version = encodeURIComponent(input.digest);
	if (input.ecosystem === "oci") return `pkg:oci/${name}@${version}`;
	return `pkg:generic/${name}@${version}`;
}

/** Package URL standing for a whole Freight (used when it has no artifacts). */
export function freightPurl(bindle: string, freightId: string): string {
	return `pkg:generic/${encodeURIComponent(bindle || "freight")}@${encodeURIComponent(freightId)}`;
}

// ── Structural check against the pinned schemas ────────────────────────────
// Mirrors the v0.5.1 JSON schemas: context keys, required subject content and
// `additionalProperties: false` on every standard content object.

const CONTEXT_KEYS = new Set([
	"specversion",
	"id",
	"source",
	"type",
	"timestamp",
	"schemaUri",
	"chainId",
	"links",
]);
const SUBJECT_KEYS = new Set(["id", "source", "type", "content"]);
const EVENT_KEYS = new Set([
	"context",
	"subject",
	"customData",
	"customDataContentType",
]);

type ContentRule = Readonly<{
	allowed: readonly string[];
	required: readonly string[];
}>;

const ENVIRONMENT_REF = ["environment"] as const;
const CONTENT_RULES = new Map<string, ContentRule>([
	[
		CDEVENT_TYPES.artifactPublished,
		{
			allowed: ["sbom", "user"],
			required: [],
		},
	],
	[
		CDEVENT_TYPES.serviceDeployed,
		{
			allowed: ["environment", "artifactId"],
			required: ["environment", "artifactId"],
		},
	],
	[
		CDEVENT_TYPES.serviceUpgraded,
		{
			allowed: ["environment", "artifactId"],
			required: ["environment", "artifactId"],
		},
	],
	[
		CDEVENT_TYPES.serviceRolledback,
		{
			allowed: ["environment", "artifactId"],
			required: ["environment", "artifactId"],
		},
	],
	[CDEVENT_TYPES.serviceRemoved, { allowed: ENVIRONMENT_REF, required: [] }],
	[
		CDEVENT_TYPES.environmentCreated,
		{
			allowed: ["name", "uri"],
			required: [],
		},
	],
	[
		CDEVENT_TYPES.environmentModified,
		{
			allowed: ["name", "uri"],
			required: [],
		},
	],
	[CDEVENT_TYPES.environmentDeleted, { allowed: ["name"], required: [] }],
]);

function nonEmpty(value: JsonValue | undefined): value is string {
	return isJsonString(value) && value.length > 0;
}

function fail(detail: string): never {
	throw new BoundaryError("cdevent-invalid", detail);
}

/** Refuse any event the pinned spec would refuse. Returns the event. */
export function assertCdEvent(event: CdEvent): CdEvent {
	for (const key of Object.keys(event)) {
		if (!EVENT_KEYS.has(key)) fail(`unknown top-level key ${key}`);
	}
	const { context, subject } = event;
	for (const key of Object.keys(context)) {
		if (!CONTEXT_KEYS.has(key)) fail(`unknown context key ${key}`);
	}
	for (const key of [
		"specversion",
		"id",
		"source",
		"type",
		"timestamp",
	] as const) {
		if (!nonEmpty(context[key])) fail(`context.${key} is required`);
	}
	if (context.specversion !== CDEVENTS_SPEC.specversion) {
		fail(
			`context.specversion ${context.specversion} is not the pinned ${CDEVENTS_SPEC.specversion}`,
		);
	}
	if (Number.isNaN(Date.parse(context.timestamp))) {
		fail("context.timestamp is not RFC 3339");
	}
	for (const key of Object.keys(subject)) {
		if (!SUBJECT_KEYS.has(key)) fail(`unknown subject key ${key}`);
	}
	if (!nonEmpty(subject.id)) fail("subject.id is required");
	if (!isJsonObject(subject.content)) {
		fail("subject.content is required");
	}
	if (context.type.startsWith(HOBO_CUSTOM_EVENT_PREFIX)) return event;
	if (!context.type.startsWith("dev.cdevents.")) {
		fail(
			`context.type ${context.type} is neither dev.cdevents nor dev.cdeventsx.hobo-`,
		);
	}
	const rule = CONTENT_RULES.get(context.type);
	if (rule === undefined) fail(`context.type ${context.type} is not pinned`);
	for (const key of Object.keys(subject.content)) {
		if (!rule.allowed.includes(key))
			fail(`${context.type} content has no ${key}`);
	}
	for (const key of rule.required) {
		if (subject.content[key] === undefined)
			fail(`${context.type} content.${key} is required`);
	}
	const environment = subject.content.environment;
	if (environment !== undefined) {
		if (!isJsonObject(environment))
			fail("content.environment must be an object");
		if (!nonEmpty(environment.id)) fail("content.environment.id is required");
		for (const key of Object.keys(environment)) {
			if (key !== "id" && key !== "source")
				fail(`content.environment has no ${key}`);
		}
	}
	if (
		subject.content.artifactId !== undefined &&
		!nonEmpty(subject.content.artifactId)
	) {
		fail("content.artifactId must be a non-empty string");
	}
	return event;
}
