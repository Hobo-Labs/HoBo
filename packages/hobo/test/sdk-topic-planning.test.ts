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
	const definitions = parseRegisteredDefinitions({
		providerId: provider.id,
		definitions: caps.capabilities.map((entry) => ({
			...entry,
			regions: ["local"],
		})),
	});
	const registry = {
		catalogHash: "kafka-native-messaging",
		providers: () => [provider.id],
		definitions: () => definitions,
	};

	it("publishes no Component-WIT topic or queue offer from Kafka", () => {
		expect(caps.capabilities).toEqual([]);
	});

	it("refuses to plan a declared topic against Kafka's native messaging catalog", () => {
		const app = bindle("topic-test", (b) => ({
			events: b.topic().allow("publish", "subscribe"),
		}));
		const manifest = collectBindleManifest(
			targetFromBindleDefinition(app),
		).manifest;
		expect(plan(manifest, { deploymentId: "topic-test" }, registry).ok).toBe(
			false,
		);
	});

	it("refuses to plan a queue against Kafka's native messaging catalog", () => {
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
