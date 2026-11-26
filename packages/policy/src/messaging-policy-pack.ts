/**
 * Example policy pack for Messaging plane (ADR-0138).
 * - require exactly-once for production topics
 * - deny Dapr in selected environments
 * - tenant topic quotas (soft)
 */

export const MESSAGING_POLICY_PACK_ID = "hobo.policy.messaging/v1";

export interface MessagingPolicyPack {
	readonly id: typeof MESSAGING_POLICY_PACK_ID;
	readonly requireExactlyOnceIn: readonly string[];
	readonly denyDaprIn: readonly string[];
	readonly maxTopicsPerTenant: number;
	readonly denyCrossTenantMessaging: true;
}

export const DEFAULT_MESSAGING_POLICY_PACK: MessagingPolicyPack = Object.freeze(
	{
		id: MESSAGING_POLICY_PACK_ID,
		requireExactlyOnceIn: ["prod", "production"],
		denyDaprIn: ["prod-regulated", "air-gap"],
		maxTopicsPerTenant: 100,
		denyCrossTenantMessaging: true,
	},
);

export interface MessagingPolicyEvaluation {
	readonly allowed: boolean;
	readonly reasons: readonly string[];
}

export function evaluateMessagingPolicy(input: {
	readonly pack?: MessagingPolicyPack;
	readonly environment: string;
	readonly delivery: "at-least-once" | "exactly-once" | "at-most-once";
	readonly runtime: string;
	readonly topicCount: number;
	readonly publisherTenant: string;
	readonly consumerTenant: string;
}): MessagingPolicyEvaluation {
	const pack = input.pack ?? DEFAULT_MESSAGING_POLICY_PACK;
	const reasons: string[] = [];

	if (
		pack.requireExactlyOnceIn.includes(input.environment) &&
		input.delivery !== "exactly-once"
	) {
		reasons.push(
			`environment '${input.environment}' requires exactly-once delivery`,
		);
	}
	if (
		pack.denyDaprIn.includes(input.environment) &&
		(input.runtime === "dapr" || input.runtime === "runtime-dapr")
	) {
		reasons.push(`Dapr runtime denied in environment '${input.environment}'`);
	}
	if (input.topicCount > pack.maxTopicsPerTenant) {
		reasons.push(
			`topic quota exceeded (${input.topicCount} > ${pack.maxTopicsPerTenant})`,
		);
	}
	if (
		pack.denyCrossTenantMessaging &&
		input.publisherTenant !== input.consumerTenant
	) {
		reasons.push("cross-tenant messaging denied by policy");
	}

	return { allowed: reasons.length === 0, reasons };
}
