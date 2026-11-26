import { camp } from "@hobo/camps";
import { deriveMessagingFederationPlan, junction } from "@hobo/junctions";
import { yard } from "@hobo/yards";
import { describe, expect, it } from "vitest";

import {
	createProofHosts,
	runActorDual,
	runDaprKafkaPath,
	runNativeKafkaPath,
} from "../src/scenarios.js";

function makeYard(name: string, providerId: string) {
	const dev = camp("dev", {
		envType: "development",
		require: ["managed-http-runtime"],
		runtimeRequirements: ["local"],
	});
	return yard(name, {
		provider: providerId,
		regions: ["local"],
		camps: [dev],
	});
}

describe("messaging-dapr-kafka proof", () => {
	it("native Kafka path publish/consume + audit events (live transport)", async () => {
		const result = await runNativeKafkaPath("acme");
		expect(result.published).toBe(2);
		expect(result.consumed).toBe(2);
		expect(result.fidelity).toBe("live");
		expect(result.messaging.backend).toBe("native-kafka");
		expect(result.events).toContain("messaging.published");
		expect(result.events).toContain("messaging.acked");
	});

	it("Dapr path messaging + secretless component YAML (live client)", async () => {
		const result = await runDaprKafkaPath("acme");
		expect(result.appId).toBe("acme.prod.app");
		expect(result.fidelity).toBe("live");
		expect(result.consumed).toBe(1);
		expect(result.yaml).toContain("pubsub.kafka");
		expect(result.yaml).toContain("fromBinding:kafka-bootstrap");
		expect(result.yaml).not.toMatch(/password:/i);
	});

	it("actor dual placement: same defineActor under native and dapr hosts", async () => {
		const hosts = createProofHosts("acme");
		const { nativeTotal, daprTotal } = await runActorDual(
			hosts.native,
			hosts.dapr,
		);
		expect(nativeTotal).toBe(3);
		expect(daprTotal).toBe(3);
	});

	it("junction messaging federation plan for cross-cloud topics", () => {
		const def = junction("mesh", {
			yards: [makeYard("aws-yard", "aws"), makeYard("azure-yard", "azure")],
		});
		const plan = deriveMessagingFederationPlan({
			definition: def,
			topics: ["orders"],
			actorTypes: ["Order"],
		});
		expect(plan.topics.length).toBe(2);
		expect(plan.actorSignals.length).toBe(2);
		expect(plan.topics[0]?.identityAudience).toContain("orders");
	});
});
