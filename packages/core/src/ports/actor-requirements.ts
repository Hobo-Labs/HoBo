/**
 * Semantic actor requirements. Product names are not allowed here.
 * Matching treats these as hard filters against resolver descriptors.
 */

import { CoreParseError } from "../errors.js";
import {
	isJsonBoolean,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";

export type ActorConcurrency = "serial" | "parallel" | "provider-native";
export type ActorCommit = "before-ack" | "batched" | "explicit";
export type ActorInbox =
	| "none"
	| "durable-at-most-once-after-receive"
	| "durable-at-least-once-deduplicated";
export type ActorTenantIsolation = "trusted" | "semi-trusted" | "hostile";
export type ActorWebsocketHibernation = "required" | "preferred" | "none";

export interface ActorPlacementRequirement {
	readonly movableWithinFleet: boolean;
	readonly regionPinned: boolean;
}

export interface ActorRequirements {
	readonly concurrency: ActorConcurrency;
	readonly commit: ActorCommit;
	readonly inbox: ActorInbox;
	readonly placement: ActorPlacementRequirement;
	readonly websocketHibernation: ActorWebsocketHibernation;
	readonly tenantIsolation: ActorTenantIsolation;
}

export class ActorRequirementsParseError extends CoreParseError {
	constructor(path: string, expected: string, received: JsonValue | undefined) {
		super("HOBO_CORE_ACTOR_REQUIREMENTS_PARSE", path, expected, received);
		this.name = "ActorRequirementsParseError";
	}
}

const CONCURRENCY = new Set<ActorConcurrency>([
	"serial",
	"parallel",
	"provider-native",
]);
const COMMIT = new Set<ActorCommit>(["before-ack", "batched", "explicit"]);
const INBOX = new Set<ActorInbox>([
	"none",
	"durable-at-most-once-after-receive",
	"durable-at-least-once-deduplicated",
]);
const ISOLATION = new Set<ActorTenantIsolation>([
	"trusted",
	"semi-trusted",
	"hostile",
]);
const WS = new Set<ActorWebsocketHibernation>([
	"required",
	"preferred",
	"none",
]);

function oneOf<T extends string>(
	value: JsonValue | undefined,
	path: string,
	allowed: Set<T>,
): T {
	// SAFETY: assertion required at this I/O or test boundary.
	if (isJsonString(value)) {
		for (const allowedValue of allowed) {
			if (value === allowedValue) return allowedValue;
		}
	}
	throw new ActorRequirementsParseError(path, [...allowed].join("|"), value);
}

export function parseActorRequirements(
	input: JsonValue | undefined,
): ActorRequirements {
	if (!isJsonObject(input) || input === null || Array.isArray(input)) {
		throw new ActorRequirementsParseError("requirements", "object", input);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const record = input as JsonObject;
	const placementRaw = record.placement;
	if (
		!isJsonObject(placementRaw) ||
		placementRaw === null ||
		Array.isArray(placementRaw)
	) {
		throw new ActorRequirementsParseError("placement", "object", placementRaw);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const placement = placementRaw as JsonObject;
	if (!isJsonBoolean(placement.movableWithinFleet)) {
		throw new ActorRequirementsParseError(
			"placement.movableWithinFleet",
			"boolean",
			placement.movableWithinFleet,
		);
	}
	if (!isJsonBoolean(placement.regionPinned)) {
		throw new ActorRequirementsParseError(
			"placement.regionPinned",
			"boolean",
			placement.regionPinned,
		);
	}
	return Object.freeze({
		concurrency: oneOf(record.concurrency, "concurrency", CONCURRENCY),
		commit: oneOf(record.commit, "commit", COMMIT),
		inbox: oneOf(record.inbox, "inbox", INBOX),
		placement: Object.freeze({
			movableWithinFleet: placement.movableWithinFleet,
			regionPinned: placement.regionPinned,
		}),
		websocketHibernation: oneOf(
			record.websocketHibernation,
			"websocketHibernation",
			WS,
		),
		tenantIsolation: oneOf(
			record.tenantIsolation,
			"tenantIsolation",
			ISOLATION,
		),
	});
}

export type ActorResolverFamily = "native" | "dapr" | "rivet" | "celld";

export interface ActorResolverCapabilities {
	readonly family: ActorResolverFamily;
	readonly concurrency: readonly ActorConcurrency[];
	readonly commit: readonly ActorCommit[];
	readonly inbox: readonly ActorInbox[];
	readonly movableWithinFleet: boolean;
	readonly regionPinned: boolean;
	readonly websocketHibernation: readonly ActorWebsocketHibernation[];
	readonly tenantIsolation: readonly ActorTenantIsolation[];
	readonly componentModelWasm: false;
	readonly experimental: boolean;
}

export type ActorResolverRejection =
	| "FAMILY_INCOMPATIBLE"
	| "CONCURRENCY"
	| "COMMIT"
	| "INBOX"
	| "PLACEMENT"
	| "WEBSOCKET"
	| "ISOLATION"
	| "WASM_COMPONENT_MODEL"
	| "EXPERIMENTAL_DENIED";

export interface ActorResolverDecision {
	readonly family: ActorResolverFamily;
	readonly accepted: boolean;
	readonly rejections: readonly ActorResolverRejection[];
}

export function evaluateActorResolver(
	requirements: ActorRequirements,
	capabilities: ActorResolverCapabilities,
	options: { allowExperimental?: boolean } = {},
): ActorResolverDecision {
	const rejections: ActorResolverRejection[] = [];
	if (!capabilities.concurrency.includes(requirements.concurrency)) {
		rejections.push("CONCURRENCY");
	}
	if (!capabilities.commit.includes(requirements.commit)) {
		rejections.push("COMMIT");
	}
	if (!capabilities.inbox.includes(requirements.inbox)) {
		rejections.push("INBOX");
	}
	if (
		requirements.placement.movableWithinFleet &&
		!capabilities.movableWithinFleet
	) {
		rejections.push("PLACEMENT");
	}
	if (requirements.placement.regionPinned && !capabilities.regionPinned) {
		rejections.push("PLACEMENT");
	}
	if (
		requirements.websocketHibernation === "required" &&
		!capabilities.websocketHibernation.includes("required")
	) {
		rejections.push("WEBSOCKET");
	}
	if (!capabilities.tenantIsolation.includes(requirements.tenantIsolation)) {
		rejections.push("ISOLATION");
	}
	if (capabilities.experimental && options.allowExperimental !== true) {
		rejections.push("EXPERIMENTAL_DENIED");
	}
	return Object.freeze({
		family: capabilities.family,
		accepted: rejections.length === 0,
		rejections: Object.freeze(rejections),
	});
}

/** Honest published capabilities. Flux is omitted — it is not an actor resolver. */
export const NATIVE_ACTOR_CAPABILITIES: ActorResolverCapabilities = {
	family: "native",
	concurrency: ["serial", "provider-native"],
	commit: ["before-ack", "explicit"],
	inbox: ["none", "durable-at-least-once-deduplicated"],
	movableWithinFleet: false,
	regionPinned: false,
	websocketHibernation: ["none", "preferred"],
	tenantIsolation: ["trusted"],
	componentModelWasm: false,
	experimental: false,
};

export const RIVET_ACTOR_CAPABILITIES: ActorResolverCapabilities = {
	family: "rivet",
	concurrency: ["serial", "parallel", "provider-native"],
	// before-ack is the HoBo journal adapter, not raw Rivet c.state batching.
	commit: ["before-ack", "explicit", "batched"],
	inbox: [
		"none",
		"durable-at-most-once-after-receive",
		"durable-at-least-once-deduplicated",
	],
	movableWithinFleet: false,
	regionPinned: true,
	websocketHibernation: ["none", "preferred"],
	tenantIsolation: ["trusted", "semi-trusted"],
	componentModelWasm: false,
	experimental: false,
};

export const CELLD_ACTOR_CAPABILITIES: ActorResolverCapabilities = {
	family: "celld",
	concurrency: ["serial", "provider-native"],
	commit: ["before-ack"],
	inbox: ["none", "durable-at-least-once-deduplicated"],
	movableWithinFleet: true,
	regionPinned: false,
	websocketHibernation: ["required", "preferred", "none"],
	tenantIsolation: ["trusted"],
	componentModelWasm: false,
	experimental: true,
};
