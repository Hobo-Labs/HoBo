import { PORTABLE_MESSAGING_CAPABILITIES } from "@hobo/core";
import { KAFKA_MESSAGING_CAPABILITIES } from "@hobo/provider-kafka";
import { describe, expect, it } from "vitest";

import { evaluateMessagingCanDeploy } from "../src/messaging-can-deploy.js";

describe("evaluateMessagingCanDeploy", () => {
	it("rejects exactly-once on portable-only backend", () => {
		const r = evaluateMessagingCanDeploy({
			requiredDelivery: "exactly-once",
			backendCapabilities: PORTABLE_MESSAGING_CAPABILITIES,
		});
		expect(r.ok).toBe(false);
		expect(r.reasons[0]?.code).toBe("MESSAGING_DELIVERY_UNSUPPORTED");
	});

	it("accepts exactly-once on Kafka capabilities", () => {
		const r = evaluateMessagingCanDeploy({
			requiredDelivery: "exactly-once",
			backendCapabilities: KAFKA_MESSAGING_CAPABILITIES,
		});
		expect(r.ok).toBe(true);
	});

	it("denies dapr when environment is deny-listed", () => {
		const r = evaluateMessagingCanDeploy({
			requiredDelivery: "at-least-once",
			backendCapabilities: PORTABLE_MESSAGING_CAPABILITIES,
			selectedRuntime: "dapr",
			denyDaprEnvironments: ["prod-regulated"],
			environment: "prod-regulated",
		});
		expect(r.ok).toBe(false);
		expect(r.reasons.some((x) => x.code === "MESSAGING_DAPR_DENIED")).toBe(
			true,
		);
	});
});
