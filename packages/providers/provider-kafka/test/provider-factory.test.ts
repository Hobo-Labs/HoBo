import { MESSAGING_WIT_INTERFACE } from "@hobo/core";
import { describe, expect, it } from "vitest";

import { createKafkaProvider } from "../src/provider.js";
import { localRedpandaCluster } from "../src/realize.js";

const CLUSTER = {
	name: "events",
	tenantId: "acme",
	kind: "redpanda" as const,
	bootstrapServers: ["broker-1:9092"],
	credentialBindingRef: "fromBinding:kafka",
	transactional: false,
	idempotentProducer: true,
};

describe("provider identity", () => {
	it("is frozen, so a caller cannot repoint it after construction", () => {
		const provider = createKafkaProvider({ env: {} });
		expect(Object.isFrozen(provider)).toBe(true);
	});

	it("declares both WIT exports it implements", () => {
		const provider = createKafkaProvider({ env: {} });
		expect(provider.witExports).toContain(MESSAGING_WIT_INTERFACE);
		expect(provider.witExports).toContain("hobo:queue/queue@0.1.0");
	});

	it("publishes a capability manifest naming itself", () => {
		const provider = createKafkaProvider({ env: {} });
		const manifest = provider.capabilityManifest();
		expect(manifest).toBeDefined();
		expect(provider.id).toBeDefined();
	});

	it("exposes the declared messaging capabilities", () => {
		expect(createKafkaProvider({ env: {} }).capabilities).toBeDefined();
	});
});

describe("cluster and tenant defaults", () => {
	it("defaults the tenant to local", () => {
		const { iacHints } = createKafkaProvider({ env: {} }).realize({});
		expect(iacHints[0]).toContain("kafka.cluster:");
	});

	it("defaults the cluster to a local Redpanda for the resolved tenant", () => {
		const provider = createKafkaProvider({ tenantId: "acme", env: {} });
		const { cluster } = provider.realize({});
		expect(cluster.tenantId).toBe("acme");
		expect(cluster.name).toBe(localRedpandaCluster("acme").name);
	});

	it("honours an explicit cluster over the default", () => {
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		const { cluster } = provider.realize({});
		expect(cluster.name).toBe("events");
		expect(cluster.kind).toBe("redpanda");
	});

	it("lets a realize call override the provider's cluster", () => {
		const provider = createKafkaProvider({ env: {} });
		const { cluster } = provider.realize({ cluster: CLUSTER });
		expect(cluster.name).toBe("events");
	});

	it("does not let a per-call cluster persist into the next call", () => {
		const provider = createKafkaProvider({ tenantId: "acme", env: {} });
		provider.realize({ cluster: CLUSTER });
		expect(provider.realize({}).cluster.name).toBe(
			localRedpandaCluster("acme").name,
		);
	});
});

describe("realize", () => {
	const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });

	it("emits an IaC hint for the cluster", () => {
		const { iacHints } = provider.realize({});
		expect(iacHints).toContain("kafka.cluster:redpanda:events");
	});

	it("emits an IaC hint per topic carrying its partition and replication counts", () => {
		const { iacHints } = provider.realize({
			topics: [{ name: "orders", partitions: 3, replicationFactor: 2 }],
		});
		expect(iacHints).toContain("kafka.topic:orders:partitions=3:rf=2");
	});

	it("defaults a topic's cluster to the realized cluster's name", () => {
		const { topics } = provider.realize({ topics: [{ name: "orders" }] });
		expect(topics[0]?.cluster).toBe("events");
	});

	it("defaults a topic's tenant to the cluster's tenant", () => {
		const { topics } = provider.realize({ topics: [{ name: "orders" }] });
		expect(topics[0]?.tenantId).toBe("acme");
	});

	it("lets a topic name its own cluster and tenant", () => {
		const { topics } = provider.realize({
			topics: [{ name: "orders", cluster: "other", tenantId: "beta" }],
		});
		expect(topics[0]?.cluster).toBe("other");
		expect(topics[0]?.tenantId).toBe("beta");
	});

	it("accepts the snake_case tenant spelling on a topic", () => {
		const { topics } = provider.realize({
			topics: [{ name: "orders", tenant_id: "beta" }],
		});
		expect(topics[0]?.tenantId).toBe("beta");
	});

	it("realizes an empty topic list", () => {
		const { topics, iacHints } = provider.realize({});
		expect(topics).toEqual([]);
		expect(iacHints).toHaveLength(2);
	});

	it("emits the credential binding as a hint, never the credential", () => {
		const { iacHints, secretless } = provider.realize({});
		expect(iacHints).toContain("credential.binding:fromBinding:kafka");
		expect(iacHints.join(" ")).not.toContain("password");
		expect(secretless).toBe(true);
	});

	it("reports the messaging backend and WIT exports on the result", () => {
		const result = provider.realize({});
		expect(result.messagingBackend).toBe("native-kafka");
		expect(result.witExports).toContain(MESSAGING_WIT_INTERFACE);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("realizes several topics in order", () => {
		const { topics } = provider.realize({
			topics: [{ name: "a" }, { name: "b" }, { name: "c" }],
		});
		expect(topics.map((topic) => topic.name)).toEqual(["a", "b", "c"]);
	});

	it("refuses a malformed topic rather than skipping it", () => {
		expect(() =>
			provider.realize({ topics: [{ name: "orders", partitions: 0 }] }),
		).toThrow();
		expect(() => provider.realize({ topics: [{}] })).toThrow();
	});

	it("refuses a malformed cluster override", () => {
		expect(() => provider.realize({ cluster: { name: "" } })).toThrow();
		expect(() =>
			provider.realize({ cluster: { ...CLUSTER, password: "hunter2" } }),
		).toThrow();
	});
});

describe("createMessaging", () => {
	it("builds a messaging client from the resolved cluster", () => {
		const messaging = createKafkaProvider({
			cluster: CLUSTER,
			env: {},
		}).createMessaging();
		expect(messaging).toBeDefined();
	});

	it("accepts a per-call transport override", () => {
		const transport = { kind: "injected" } as never;
		const messaging = createKafkaProvider({
			cluster: CLUSTER,
			env: {},
		}).createMessaging({ transport });
		expect(messaging).toBeDefined();
	});

	it("accepts an explicit live: false", () => {
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		expect(provider.createMessaging({ live: false })).toBeDefined();
	});

	it("refuses live fidelity with no transport to be live against", () => {
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		expect(() => provider.createMessaging({ live: true })).toThrow(
			/live fidelity requires a KafkaBrokerTransport/u,
		);
	});

	it("allows a transport that explicitly declares live fidelity", () => {
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		expect(
			provider.createMessaging({
				live: true,
				transport: { kind: "injected", fidelity: "live" } as never,
			}),
		).toBeDefined();
	});

	it("uses the provider's transport when a call names none", () => {
		const transport = { kind: "constructed" } as never;
		const provider = createKafkaProvider({
			cluster: CLUSTER,
			transport,
			env: {},
		});
		expect(provider.createMessaging()).toBeDefined();
	});

	it("does not let a per-call transport persist into the next call", () => {
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		provider.createMessaging({ transport: { kind: "once" } as never });
		expect(provider.createMessaging()).toBeDefined();
	});
});

describe("transport resolution from the environment", () => {
	it("resolves from an injected environment rather than the ambient one", () => {
		expect(() =>
			createKafkaProvider({ cluster: CLUSTER, env: {} }),
		).not.toThrow();
	});

	it("resolves once at construction, not per call", () => {
		const env: Record<string, string | undefined> = {};
		const provider = createKafkaProvider({ cluster: CLUSTER, env });
		env.KAFKA_BOOTSTRAP_SERVERS = "changed:9092";
		expect(provider.createMessaging()).toBeDefined();
	});

	it("falls back to process.env when no environment is injected", () => {
		expect(() => createKafkaProvider({ cluster: CLUSTER })).not.toThrow();
	});
});
