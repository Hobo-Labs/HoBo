/**
 * Gatekeeper / can-deploy reasons for messaging capability + delivery-guarantee
 * mismatches (ADR-0138).
 */

import type { DeliveryGuarantee, MessagingCapabilities } from "@hobo/core";
import { assertDeliverySupported, MessagingCapabilityError } from "@hobo/core";

export interface MessagingCanDeployRequest {
	readonly requiredDelivery: DeliveryGuarantee;
	readonly backendCapabilities: MessagingCapabilities;
	readonly allowDapr?: boolean;
	readonly selectedRuntime?: string;
	readonly denyDaprEnvironments?: readonly string[];
	readonly environment?: string;
	readonly requireExactlyOnce?: boolean;
}

export interface MessagingCanDeployReason {
	readonly code: string;
	readonly message: string;
	readonly suggestedFix: string;
}

export interface MessagingCanDeployResult {
	readonly ok: boolean;
	readonly reasons: readonly MessagingCanDeployReason[];
}

export function evaluateMessagingCanDeploy(
	req: MessagingCanDeployRequest,
): MessagingCanDeployResult {
	const reasons: MessagingCanDeployReason[] = [];

	try {
		assertDeliverySupported(req.backendCapabilities, req.requiredDelivery);
	} catch (err) {
		const message =
			err instanceof MessagingCapabilityError ? err.message : String(err);
		reasons.push({
			code: "MESSAGING_DELIVERY_UNSUPPORTED",
			message,
			suggestedFix:
				"Select a backend that advertises the required delivery guarantee (e.g. Kafka transactional) or lower the Bindle requirement.",
		});
	}

	if (req.requireExactlyOnce && req.requiredDelivery !== "exactly-once") {
		reasons.push({
			code: "MESSAGING_EXACTLY_ONCE_POLICY",
			message: "Policy requires exactly-once delivery",
			suggestedFix:
				"Set topic delivery to exactly-once and realize onto a transactional Kafka capability.",
		});
	}

	const runtime = req.selectedRuntime ?? "local";
	const env = req.environment ?? "dev";
	if (
		runtime === "dapr" &&
		(req.allowDapr === false || (req.denyDaprEnvironments ?? []).includes(env))
	) {
		reasons.push({
			code: "MESSAGING_DAPR_DENIED",
			message: `Dapr runtime denied in environment '${env}' (ADR-0031 default path preferred)`,
			suggestedFix:
				"Remove dapr from Camp runtimeRequirements or adjust policy pack allow-list.",
		});
	}

	return {
		ok: reasons.length === 0,
		reasons,
	};
}
