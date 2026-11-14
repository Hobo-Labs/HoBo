import { bindle, collectBindleManifest } from "@hobo/bindles";
import { targetFromBindleDefinition } from "@hobo/cli";
import { parseRegisteredDefinitions, plan } from "@hobo/cloud";
import { createKafkaProvider } from "@hobo/provider-kafka";
import { describe, expect, it } from "vitest";

describe("SDK topic planning", () => {
	const provider = createKafkaProvider({ tenantId: "tenant", env: {} });
	const docs = provider.capabilityManifest();
	// SAFETY: this fixture reads the capability manifest produced by this provider.
	const caps = JSON.parse(
		docs["/.well-known/capability-manifest/capabilities.json"],
	) as {
		capabilities: { port: string; features: string[] }[];
	};
	// SAFETY: this fixture reads the cost manifest produced by the same provider.
	const cost = JSON.parse(
		docs["/.well-known/capability-manifest/cost.json"],
	) as {
		facts: { port: string; sku: string; unit: string; marginalPrice: string }[];
	};
	const topic = caps.capabilities.find((entry) => entry.port === "topic");
	const topicCost = cost.facts.find((entry) => entry.port === "topic");
	if (!topic || !topicCost)
		throw new Error("Kafka topic definition is unavailable");
	const definitions = parseRegisteredDefinitions({
		providerId: provider.id,
		definitions: [{ ...topic, cost: topicCost, regions: ["local"] }],
	});
	const registry = {
		catalogHash: "kafka-topic",
		providers: () => [provider.id],
		definitions: () => definitions,
	};
	it("plans a declared topic using Kafka's published topic capability and price", () => {
		const app = bindle("topic-test", (b) => ({
			events: b.topic().allow("publish", "subscribe"),
		}));
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(app),
		).manifest;
		const result = plan(manifest, { deploymentId: "topic-test" }, registry);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.reason);
		expect(result.plan.resources[0]).toMatchObject({
			name: "events",
			port: "topic",
			provider: provider.id,
		});
	});
	it("does not select a topic-only offer for a queue", () => {
		const app = bindle("queue-test", (b) => ({
			jobs: b.queue().allow("enqueue", "dequeue"),
		}));
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(app),
		).manifest;
		expect(plan(manifest, { deploymentId: "queue-test" }, registry).ok).toBe(
			false,
		);
	});
});
