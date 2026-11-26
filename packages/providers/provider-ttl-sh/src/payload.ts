/**
 * What may be pushed — expressed as types, not as a warning in a README.
 *
 * This transport must refuse to become durable storage. Prose cannot enforce that:
 * "please don't put your database backup here" is advice, and advice loses to a
 * deadline. So the refusal lives in the shape of the API.
 *
 * There is exactly one way to describe a payload, {@link parseArtifactPayload}, and
 * its result type has no variant for application state and no variant for a
 * database backup. A caller cannot construct one, so there is no argument for a
 * push to accept. The runtime check on {@link REFUSED_PAYLOAD_KINDS} exists for
 * input that arrived as `unknown` from a config file or an HTTP body, where the type
 * system was never consulted.
 *
 * The one narrow exception the mission allows — an explicitly accepted temporary
 * handoff — is representable, and it costs the caller something to say. It must name
 * where the durable copy lives, name the owner-controlled registry the artifact will
 * be promoted into, name who accepted the risk, and commit to a promotion deadline
 * inside the artifact's own TTL. An acknowledgement is therefore a statement with a
 * subject and a deadline rather than a boolean somebody flipped.
 */
import { TtlShProviderError } from "./errors.js";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import type { TtlWindow } from "./reference.js";

/**
 * Payload kinds this transport exists for.
 *
 * Every one is reproducible from source: if the artifact vanishes, the recovery
 * procedure is "run the build again". That is what makes a 24-hour ceiling
 * acceptable in the first place.
 */
export const EPHEMERAL_PAYLOAD_KINDS = [
	/** An image built in a CI job and consumed by a later job in the same run. */
	"ci-build-image",
	/** A fixture image an integration test pulls and then discards. */
	"integration-test-fixture",
	/** An artifact handed between two machines the same operator controls. */
	"cross-machine-handoff",
	/** A candidate pack image under review, before it is pinned in a manifest. */
	"pack-candidate-image",
] as const;

export type EphemeralPayloadKind = (typeof EPHEMERAL_PAYLOAD_KINDS)[number];

/**
 * Kinds that are refused, named so the refusal can be explicit.
 *
 * These strings exist only so input arriving as `unknown` can be rejected with a
 * message that says which rule it broke. None of them is assignable to
 * {@link ArtifactPayload}, so no typed call site can reach a push with one.
 */
export const REFUSED_PAYLOAD_KINDS = [
	"application-state",
	"database-backup",
	"event-store-journal",
	"secret-material",
	"audit-log",
	"only-copy-of-anything",
] as const;

export type RefusedPayloadKind = (typeof REFUSED_PAYLOAD_KINDS)[number];

function durableUseRefused(detail: string): never {
	throw new TtlShProviderError("ARTIFACT_DURABLE_USE_REFUSED", detail);
}

function promotionTargetInvalid(detail: string): never {
	throw new TtlShProviderError("PROMOTION_TARGET_INVALID", detail);
}

declare const ownerRegistryBrand: unique symbol;

/** A registry somebody is responsible for, which is by definition not this one. */
export type OwnerControlledRegistry = string & {
	readonly [ownerRegistryBrand]: "OwnerControlledRegistry";
};

const REGISTRY_HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$/u;

/**
 * Registries that are anonymous and expiring, and therefore cannot be a promotion
 * target. A promotion into one of them would be a lifetime extension dressed up as
 * ownership.
 */
const EPHEMERAL_REGISTRY_HOSTS: readonly string[] = ["ttl.sh", "ttl.sh:443"];

export function parseOwnerControlledRegistry(
	input: string,
): OwnerControlledRegistry {
	const host = input.toLowerCase();
	if (!REGISTRY_HOST.test(host) || host.length > 253) {
		promotionTargetInvalid(
			"promotion target must be a bare registry host, optionally with a port",
		);
	}
	if (EPHEMERAL_REGISTRY_HOSTS.includes(host)) {
		promotionTargetInvalid(
			`${host} is an anonymous expiring registry; promoting into it changes the expiry date and nothing about who is responsible for the bytes`,
		);
	}
	// SAFETY: host passed REGISTRY_HOST, length, and ephemeral-registry checks.
	return host as OwnerControlledRegistry;
}

/**
 * The signed-in-blood version of "yes, I know this is temporary".
 *
 * Every field is load-bearing. `durableCopyLocation` is the answer to "what happens
 * when this vanishes" — if there is no answer, the push must not happen.
 * `promotionTarget` and `promoteWithinMinutes` turn the intention into something a
 * projection can check and an alarm can fire on.
 */
export type TemporaryHandoffAcknowledgement = {
	/** Who accepted the risk. A person or a pipeline, not "the system". */
	readonly acceptedBy: string;
	/** Why this is going through an ephemeral registry at all. */
	readonly reason: string;
	/** Where the durable copy of this data lives *right now*. */
	readonly durableCopyLocation: string;
	/** The owner-controlled registry this artifact will be promoted into. */
	readonly promotionTarget: OwnerControlledRegistry;
	/** Promotion deadline, which must fall inside the artifact's own TTL. */
	readonly promoteWithinMinutes: number;
};

export type EphemeralPayload = {
	readonly kind: EphemeralPayloadKind;
	/** Media type of the artifact's manifest config, for the receipt. */
	readonly artifactType: string;
	/** How the payload is regenerated if it vanishes. Required, not optional. */
	readonly reproducedBy: string;
};

/**
 * A payload that is data rather than a build output, pushed under an explicit,
 * bounded, attributed acknowledgement.
 *
 * Deliberately awkward to construct. The awkwardness is the feature: an
 * acknowledged handoff should read, in review, as a decision somebody made.
 */
export type AcknowledgedTemporaryHandoff = {
	readonly kind: "accepted-temporary-handoff";
	readonly artifactType: string;
	readonly acknowledgement: TemporaryHandoffAcknowledgement;
};

/**
 * Everything this transport will carry.
 *
 * No `application-state`. No `database-backup`. Not as a check — as an absence.
 */
export type ArtifactPayload = EphemeralPayload | AcknowledgedTemporaryHandoff;

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

function parseArtifactType(input: JsonValue | undefined): string {
	if (!isJsonString(input) || !MEDIA_TYPE.test(input) || input.length > 255) {
		throw new TtlShProviderError(
			"INVALID_IMAGE_REFERENCE",
			"artifactType must be a media type such as application/vnd.oci.image.config.v1+json",
		);
	}
	return input;
}

function requireSentence(input: JsonValue | undefined, field: string): string {
	if (!isJsonString(input) || input.trim().length < 8 || input.length > 512) {
		durableUseRefused(
			`${field} must be 8-512 characters describing the actual answer`,
		);
	}
	return input.trim();
}

function asJsonObject(input: JsonValue | undefined, what: string): JsonObject {
	if (!isJsonObject(input)) {
		throw new TtlShProviderError(
			"INVALID_IMAGE_REFERENCE",
			`${what} must be an object`,
		);
	}
	return input;
}

function parseAcknowledgement(
	input: JsonValue | undefined,
	ttl: TtlWindow,
): TemporaryHandoffAcknowledgement {
	const raw = asJsonObject(input, "acknowledgement");
	if (
		!isJsonNumber(raw.promoteWithinMinutes) ||
		!Number.isInteger(raw.promoteWithinMinutes) ||
		raw.promoteWithinMinutes < 1
	) {
		durableUseRefused(
			"acknowledgement.promoteWithinMinutes must be a whole number of minutes",
		);
	}
	const deadline = raw.promoteWithinMinutes;
	if (deadline > ttl.minutes) {
		// A promotion deadline after the artifact expires is not a plan, it is a
		// hope. Refusing it here is the difference between an operator who finds
		// out at review time and one who finds out at recovery time.
		durableUseRefused(
			`promotion deadline of ${deadline} minutes falls after the artifact's ${ttl.minutes} minute TTL; the artifact would be gone before the promotion was due`,
		);
	}
	if (!isJsonString(raw.promotionTarget)) {
		promotionTargetInvalid(
			"acknowledgement.promotionTarget must name an owner-controlled registry",
		);
	}
	return {
		acceptedBy: requireSentence(raw.acceptedBy, "acknowledgement.acceptedBy"),
		reason: requireSentence(raw.reason, "acknowledgement.reason"),
		durableCopyLocation: requireSentence(
			raw.durableCopyLocation,
			"acknowledgement.durableCopyLocation",
		),
		promotionTarget: parseOwnerControlledRegistry(raw.promotionTarget),
		promoteWithinMinutes: deadline,
	};
}

function isEphemeralKind(value: string): value is EphemeralPayloadKind {
	switch (value) {
		case "ci-build-image":
		case "integration-test-fixture":
		case "cross-machine-handoff":
		case "pack-candidate-image":
			return true;
		default:
			return false;
	}
}

function isRefusedKind(value: string): value is RefusedPayloadKind {
	switch (value) {
		case "application-state":
		case "database-backup":
		case "event-store-journal":
		case "secret-material":
		case "audit-log":
		case "only-copy-of-anything":
			return true;
		default:
			return false;
	}
}

/**
 * The one parse boundary for a payload description.
 *
 * The TTL window is a parameter because an acknowledged handoff's promotion
 * deadline is only meaningful relative to the lifetime of the artifact carrying it,
 * and checking that relationship anywhere later would mean checking it in two places
 * or in none.
 */
export function parseArtifactPayload(
	input: JsonValue | undefined,
	ttl: TtlWindow,
): ArtifactPayload {
	const raw = asJsonObject(input, "payload");
	if (!isJsonString(raw.kind)) {
		throw new TtlShProviderError(
			"INVALID_IMAGE_REFERENCE",
			"payload.kind must be a string",
		);
	}
	const kind = raw.kind;
	if (isRefusedKind(kind)) {
		durableUseRefused(
			`${kind} is durable state; this transport is an anonymous registry that deletes everything within ${ttl.minutes} minutes, grants no ownership, enforces no access control, and offers no recovery. Use accepted-temporary-handoff with an acknowledgement if a bounded handoff is genuinely what you mean.`,
		);
	}
	if (kind === "accepted-temporary-handoff") {
		return {
			kind,
			artifactType: parseArtifactType(raw.artifactType),
			acknowledgement: parseAcknowledgement(raw.acknowledgement, ttl),
		};
	}
	if (!isEphemeralKind(kind)) {
		durableUseRefused(
			`unknown payload kind ${JSON.stringify(kind)}; this transport carries only ${EPHEMERAL_PAYLOAD_KINDS.join(", ")} or an acknowledged accepted-temporary-handoff`,
		);
	}
	return {
		kind,
		artifactType: parseArtifactType(raw.artifactType),
		// Required for every reproducible kind: the recovery procedure has to be
		// written down before the artifact exists, not remembered after it is gone.
		reproducedBy: requireSentence(raw.reproducedBy, "payload.reproducedBy"),
	};
}

export function isAcknowledgedTemporaryHandoff(
	payload: ArtifactPayload,
): payload is AcknowledgedTemporaryHandoff {
	return payload.kind === "accepted-temporary-handoff";
}
