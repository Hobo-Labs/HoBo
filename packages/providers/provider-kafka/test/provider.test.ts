import {
	createMeteringBus,
	parseConsumerGroupId,
	parseTenantId,
	parseTopicName,
} from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	createKafkaMessaging,
	createKafkaProvider,
	diagnoseKafkaReadiness,
	HOBO_PROVIDER_KAFKA_PACKAGE,
	KAFKA_PROVIDER_ID,
	localRedpandaCluster,
	parseKafkaClusterSpec,
	parseKafkaResourceDefinition,
	realizeKafkaResources,
} from "../src/index.js";

describe("@hobo/provider-kafka", () => {
	it("exports package id and secretless cluster parse", () => {
		expect(HOBO_PROVIDER_KAFKA_PACKAGE).toBe("@hobo/provider-kafka");
		expect(KAFKA_PROVIDER_ID).toBe("@hobo/provider-kafka");
		const cluster = parseKafkaClusterSpec({
			name: "orders",
			tenantId: "acme",
			kind: "msk",
			bootstrapServers: ["b-1.example:9092"],
			credentialBindingRef: "fromBinding:msk-oidc",
			transactional: true,
			idempotentProducer: true,
		});
		expect(cluster.credentialBindingRef).toBe("fromBinding:msk-oidc");
		expect(() =>
			parseKafkaClusterSpec({
				name: "x",
				tenantId: "t",
				kind: "self-hosted",
				bootstrapServers: [],
				password: "secret",
			}),
		).toThrow(/secretless/);
	});

	it("realizes cluster + topics with wit exports", () => {
		const result = realizeKafkaResources({
			cluster: localRedpandaCluster("acme"),
			topics: [
				{
					name: "orders",
					cluster: "local-redpanda",
					tenantId: "acme",
					partitions: 6,
					replicationFactor: 1,
					deliveryGuarantee: "exactly-once",
				},
			],
		});
		expect(result.secretless).toBe(true);
		expect(result.messagingBackend).toBe("native-kafka");
		expect(result.witExports).toEqual([]);
		expect(result.topics[0]?.partitions).toBe(6);
	});

	it("publish/consume via kafka messaging + metering", async () => {
		const events: Array<{ eventType?: string; tenantId?: string }> = [];
		const metering = createMeteringBus([
			{
				sinkId: "test",
				emit(e) {
					events.push(e);
				},
			},
		]);
		const bus = createKafkaMessaging({
			cluster: localRedpandaCluster("t1"),
			metering,
		});
		expect(bus.backend).toBe("native-kafka");
		expect(bus.capabilities.transactionalProduce).toBe(true);
		await bus.publish(parseTopicName("orders"), { id: 1 }, { key: "k1" });
		const batch = await bus.consume(
			parseTopicName("orders"),
			parseConsumerGroupId("cg"),
		);
		expect(batch).toHaveLength(1);
		expect(events.some((e) => e.eventType === "messaging.publish")).toBe(true);
		expect(events.some((e) => e.tenantId === parseTenantId("t1"))).toBe(true);
	});

	it("provider capability manifest is secretless", () => {
		const provider = createKafkaProvider({ tenantId: "acme" });
		const docs = provider.capabilityManifest();
		const index = JSON.parse(
			docs["/.well-known/capability-manifest/index.json"],
		);
		expect(index.witExports).toEqual([]);
		expect(index.nativeMessaging).toEqual({
			contract: "hobo.messaging-port/v2",
			componentWit: false,
		});
		const auth = JSON.parse(docs["/.well-known/capability-manifest/auth.json"]);
		expect(auth.staticSecrets).toBe(false);
		expect(auth.mode).toBe("secretless-first");
		const capabilities = JSON.parse(
			docs["/.well-known/capability-manifest/capabilities.json"],
		);
		expect(capabilities.capabilities).toEqual([]);
		expect(provider.capabilities.deadLetter).toBe(false);
		expect(() =>
			provider.realize({
				topics: [
					{
						name: "t",
						partitions: 1,
						replicationFactor: 1,
						deadLetterTopic: "dead",
					},
				],
			}),
		).toThrow(/dead-letter/);
		const realized = provider.realize({
			topics: [{ name: "t", partitions: 1, replicationFactor: 1 }],
		});
		expect(realized.cluster.tenantId).toBe("acme");
	});

	it("doctor reports simulated fidelity without brokers", () => {
		const report = diagnoseKafkaReadiness({ env: {} });
		expect(report.fidelity).toBe("simulated");
		expect(report.remediation.length).toBeGreaterThan(0);
	});

	it("parses Resource Definitions", () => {
		const rd = parseKafkaResourceDefinition({
			apiVersion: "hobo.kafka/v1",
			kind: "KafkaCluster",
			name: "main",
			tenantId: "acme",
			spec: {
				kind: "confluent",
				bootstrap_servers: ["pkc.example:9092"],
				credential_binding_ref: "fromBinding:confluent",
				transactional: false,
				idempotent_producer: true,
			},
		});
		expect(rd.kind).toBe("KafkaCluster");
		expect("kind" in rd.spec ? rd.spec.kind : undefined).toBe("confluent");
	});
});
