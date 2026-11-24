import { isJsonObject, type JsonObject, type JsonValue } from "../json.js";

export const ENV_NETWORK_ISOLATION_POLICY_PACK_ID =
	"hobo.env-network-isolation/v1" as const;

export const ENV_NETWORK_ISOLATION_POLICY_PACK_VERSION = "1.0.0" as const;

export type EnvNetworkIsolationPolicyPack = Readonly<{
	id: typeof ENV_NETWORK_ISOLATION_POLICY_PACK_ID;
	version: typeof ENV_NETWORK_ISOLATION_POLICY_PACK_VERSION;
	failClosed: true;
	defaultDenyCrossEnv: true;
	requireControlPlaneMembership: true;
	productionDualControl: true;
	elevatedRequiresCapability: true;
	shortLivedAutoRevoke: true;
	localDevAirGap: true;
	junctionEnvScoped: true;
	agentSameOrStricter: true;
	breakGlass: Readonly<{
		dualControl: true;
		autoExpiry: true;
		maxTtlSeconds: number;
		postIncidentReview: true;
	}>;
	elevated: Readonly<{
		maxTtlSeconds: number;
		audiences: readonly string[];
	}>;
	capabilityRequiredClasses: readonly string[];
	membershipAssigners: Readonly<Record<string, readonly string[]>>;
}>;

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

export function parseEnvNetworkIsolationPolicyPack(
	raw: JsonValue,
): EnvNetworkIsolationPolicyPack {
	if (!raw || !isJsonObject(raw)) {
		throw new TypeError("env network isolation policy pack must be an object");
	}
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
	return DEFAULT_ENV_NETWORK_ISOLATION_POLICY_PACK;
}

export const ENV_ISOLATION_RAIL_POLICY_PACK_REF =
	ENV_NETWORK_ISOLATION_POLICY_PACK_ID;
