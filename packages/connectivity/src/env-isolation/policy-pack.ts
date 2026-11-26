/**
 * Versioned Environment Network Isolation policy pack.
 * Loadable by TagAcl / rego-lite and referenced from Station Rails.
 */

// public-contract: Environment Network Isolation policy pack id.
import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";

export const ENV_NETWORK_ISOLATION_POLICY_PACK_ID =
	"hobo.env-network-isolation/v1" as const;

// public-contract: Environment Network Isolation policy pack version.
export const ENV_NETWORK_ISOLATION_POLICY_PACK_VERSION = "1.0.0" as const;

export type EnvNetworkIsolationPolicyPack = Readonly<{
	id: typeof ENV_NETWORK_ISOLATION_POLICY_PACK_ID;
	version: typeof ENV_NETWORK_ISOLATION_POLICY_PACK_VERSION;
	/** Fail closed when engine / overlay control plane unavailable. */
	failClosed: true;
	/** Default deny all cross-isolation-class traffic. */
	defaultDenyCrossEnv: true;
	/** Require control-plane membership for isolation-critical env labels. */
	requireControlPlaneMembership: true;
	/** Production dual control for membership assignment. */
	productionDualControl: true;
	/** Elevated access requires short-lived capability (not network alone). */
	elevatedRequiresCapability: true;
	/** Preview / ephemeral auto-revoke on expiry. */
	shortLivedAutoRevoke: true;
	/** Local-dev never joins remote overlays by default. */
	localDevAirGap: true;
	/** Junction federation denied across isolation classes by default. */
	junctionEnvScoped: true;
	/** Agents constrained identically or more strictly. */
	agentSameOrStricter: true;
	/** Break-glass dual control + auto-expiry + review obligation. */
	breakGlass: Readonly<{
		dualControl: true;
		autoExpiry: true;
		maxTtlSeconds: number;
		postIncidentReview: true;
	}>;
	/** Elevated capability defaults. */
	elevated: Readonly<{
		maxTtlSeconds: number;
		audiences: readonly string[];
	}>;
	/** Classes for which network membership alone never authorizes. */
	capabilityRequiredClasses: readonly string[];
	/** Who may assign which isolation class (control-plane roles). */
	membershipAssigners: Readonly<Record<string, readonly string[]>>;
}>;

/** Default signed-ready pack document. */
export const DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK: EnvNetworkIsolationPolicyPack =
	Object.freeze({
		id: ENV_NETWORK_ISOLATION_POLICY_PACK_ID,
		version: ENV_NETWORK_ISOLATION_POLICY_PACK_VERSION,
		failClosed: true as const,
		defaultDenyCrossEnv: true as const,
		requireControlPlaneMembership: true as const,
		productionDualControl: true as const,
		elevatedRequiresCapability: true as const,
		shortLivedAutoRevoke: true as const,
		localDevAirGap: true as const,
		junctionEnvScoped: true as const,
		agentSameOrStricter: true as const,
		breakGlass: Object.freeze({
			dualControl: true as const,
			autoExpiry: true as const,
			maxTtlSeconds: 3600,
			postIncidentReview: true as const,
		}),
		elevated: Object.freeze({
			maxTtlSeconds: 1800,
			audiences: Object.freeze([
				"production-access",
				"staging-access",
				"env:production",
				"env:staging",
			]),
		}),
		capabilityRequiredClasses: Object.freeze([
			"production",
			"staging",
		] as const),
		membershipAssigners: Object.freeze({
			production: Object.freeze([
				"role:control-plane-admin",
				"role:security-officer",
			]),
			staging: Object.freeze([
				"role:control-plane-admin",
				"role:platform-operator",
			]),
			development: Object.freeze([
				"role:control-plane-admin",
				"role:platform-operator",
				"role:developer",
			]),
			preview: Object.freeze([
				"role:control-plane-admin",
				"role:platform-operator",
				"role:ci",
			]),
			ephemeral: Object.freeze([
				"role:control-plane-admin",
				"role:platform-operator",
				"role:ci",
			]),
			"local-dev": Object.freeze([
				"role:control-plane-admin",
				"role:developer",
			]),
		}),
	});

/**
 * Parse-don't-validate pack boundary. Widening packs are high-risk and must be
 * policy-evaluated by the caller before activation.
 */
export function parseEnvNetworkIsolationPolicyPack(
	raw: JsonValue,
): EnvNetworkIsolationPolicyPack {
	if (!raw || !isJsonObject(raw)) {
		throw new TypeError("env network isolation policy pack must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const o = raw as JsonObject;
	if (o.id !== ENV_NETWORK_ISOLATION_POLICY_PACK_ID) {
		throw new TypeError(
			`policy pack id must be ${ENV_NETWORK_ISOLATION_POLICY_PACK_ID}`,
		);
	}
	if (o.failClosed !== true || o.defaultDenyCrossEnv !== true) {
		throw new TypeError(
			"env isolation pack must keep failClosed and defaultDenyCrossEnv true",
		);
	}
	// Only allow the default hardened pack shape for now (no silent widening).
	return DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK;
}

/** Rail policyPacks entry for Station activation. */
export const ENV_ISOLATION_RAIL_POLICY_PACK_REF =
	ENV_NETWORK_ISOLATION_POLICY_PACK_ID;
