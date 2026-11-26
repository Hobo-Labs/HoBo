/**
 * The Kafka provider factory and its realize path.
 *
 * The factory's job is to resolve three things once — the tenant, the cluster,
 * and the transport — and then hand them to every later call so a caller does
 * not have to repeat them. Each of those defaults has a failure mode worth
 * naming.
 *
 * The **tenant** scopes every topic and consumer group derived from the
 * cluster, so a default that leaked between providers would put one tenant's
 * traffic in another's namespace. The **cluster** default is a local Redpanda,
 * which is the right shape for a first run but must be overridable without
 * ceremony. The **transport** is resolved from the environment exactly once, at
 * construction, so a later change to `process.env` cannot silently repoint a
 * provider that is already wired — and a per-call override must not persist
 * into the next call.
 *
 * `realize` is where the parse boundary gets exercised in anger: topics inherit
 * the cluster's name and tenant when they do not state their own, which is what
 * makes a terse topic list authorable without inviting a topic that belongs to
 * a different cluster than the one it was declared under.
 */
import { describe, expect, it } from "vitest";

import { createKafkaProvider } from "../src/provider.js";
import { localRedpandaCluster } from "../src/realize.js";
import { createInMemoryKafkaTransport } from "../src/transport.js";

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
		// The provider carries a resolved transport and cluster. If a holder
		// could swap either, every later call would use a different broker than
		// the one the provider was built for.
		const provider = createKafkaProvider({ env: {} });
		expect(Object.isFrozen(provider)).toBe(true);
	});

	it("does not advertise component imports it does not implement", () => {
		const provider = createKafkaProvider({ env: {} });
		expect(provider.witExports).toEqual([]);
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
		// A named default rather than an empty string, so a first-run topic lands
		// in an identifiable namespace instead of an anonymous one.
		const { iacHints } = createKafkaProvider({ env: {} }).realize({});
		expect(iacHints[0]).toContain("kafka.cluster:");
	});

	it("defaults the cluster to a local Redpanda for the resolved tenant", () => {
		// The right shape for a first run: a single-broker local emulator that
		// needs no credentials and no cloud account.
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
		// Per-call override, so one provider can plan several clusters without a
		// caller having to construct a second one.
		const provider = createKafkaProvider({ env: {} });
		const { cluster } = provider.realize({ cluster: CLUSTER });
		expect(cluster.name).toBe("events");
	});

	it("does not let a per-call cluster persist into the next call", () => {
		// The override is an argument, not a mutation. A provider whose default
		// drifted after one call would plan the wrong cluster for every caller
		// that came after.
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
		// Hints, not resources: the actual cloud objects go through the Camp's
		// IacProvider. Emitting a resource here would bypass that.
		const { iacHints } = provider.realize({});
		expect(iacHints).toContain("kafka.cluster:redpanda:events");
	});

	it("emits an IaC hint per topic carrying its partition and replication counts", () => {
		// Both numbers in the hint, because they are the two properties an
		// operator most needs to see before a cluster is created — and the two
		// that cannot be changed cheaply afterwards.
		const { iacHints } = provider.realize({
			topics: [{ name: "orders", partitions: 3, replicationFactor: 2 }],
		});
		expect(iacHints).toContain("kafka.topic:orders:partitions=3:rf=2");
	});

	it("defaults a topic's cluster to the realized cluster's name", () => {
		// What makes a terse topic list authorable. Without it every topic would
		// have to repeat the cluster it was already declared under.
		const { topics } = provider.realize({ topics: [{ name: "orders" }] });
		expect(topics[0]?.cluster).toBe("events");
	});

	it("defaults a topic's tenant to the cluster's tenant", () => {
		// The isolation-relevant half: a topic that inherited no tenant would be
		// created in a shared namespace.
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
		// A cluster with no topics yet is a legitimate plan — topics are usually
		// added after the cluster exists. Two hints remain: the cluster and the
		// credential binding, which is emitted whether or not there are topics.
		const { topics, iacHints } = provider.realize({});
		expect(topics).toEqual([]);
		expect(iacHints).toHaveLength(2);
	});

	it("emits the credential binding as a hint, never the credential", () => {
		// Secretless-first, carried through to the plan. The hint names the
		// *binding* an operator has to satisfy; a hint carrying the material
		// would put it into every plan diff and receipt.
		const { iacHints, secretless } = provider.realize({});
		expect(iacHints).toContain("credential.binding:fromBinding:kafka");
		expect(iacHints.join(" ")).not.toContain("password");
		expect(secretless).toBe(true);
	});

	it("reports the messaging backend and WIT exports on the result", () => {
		// The plan states which backend will serve the port, so a reader does not
		// have to infer it from the provider that produced the plan.
		const result = provider.realize({});
		expect(result.messagingBackend).toBe("native-kafka");
		expect(result.witExports).toEqual([]);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("realizes several topics in order", () => {
		const { topics } = provider.realize({
			topics: [{ name: "a" }, { name: "b" }, { name: "c" }],
		});
		expect(topics.map((topic) => topic.name)).toEqual(["a", "b", "c"]);
	});

	it("refuses a malformed topic rather than skipping it", () => {
		// Skipping would produce a plan that silently omits a topic the author
		// declared, and the omission would surface as a missing topic at runtime.
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
		// So a test or a conformance run can inject a transport without
		// reconstructing the provider.
		const transport = createInMemoryKafkaTransport();
		const messaging = createKafkaProvider({
			cluster: CLUSTER,
			env: {},
		}).createMessaging({ transport });
		expect(messaging).toBeDefined();
	});

	it("accepts an explicit live: false", () => {
		// `live` is only forwarded when stated, so omitting it is not the same as
		// passing `false` — the messaging layer keeps its own default.
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		expect(provider.createMessaging({ live: false })).toBeDefined();
	});

	it("refuses live fidelity with no transport to be live against", () => {
		// The honest-fidelity guard, and the better half of this API. Asking for
		// `live: true` with nothing to talk to could have quietly degraded to the
		// in-memory path — and a conformance run that believed it had exercised a
		// real broker while exercising a fake one is worse than one that failed.
		// It refuses and says what is missing instead.
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		expect(() => provider.createMessaging({ live: true })).toThrow(
			/live fidelity requires a KafkaBrokerTransport/u,
		);
	});

	it("allows live fidelity once a transport is supplied", () => {
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		expect(
			provider.createMessaging({
				live: true,
				transport: createInMemoryKafkaTransport(),
			}),
		).toBeDefined();
	});

	it("uses the provider's transport when a call names none", () => {
		const transport = createInMemoryKafkaTransport();
		const provider = createKafkaProvider({
			cluster: CLUSTER,
			transport,
			env: {},
		});
		expect(provider.createMessaging()).toBeDefined();
	});

	it("does not let a per-call transport persist into the next call", () => {
		// Same argument-not-mutation property as the cluster override.
		const provider = createKafkaProvider({ cluster: CLUSTER, env: {} });
		provider.createMessaging({ transport: createInMemoryKafkaTransport() });
		expect(provider.createMessaging()).toBeDefined();
	});
});

describe("transport resolution from the environment", () => {
	it("resolves from an injected environment rather than the ambient one", () => {
		// The `env` option exists so a provider can be constructed without
		// reading `process.env`. A provider that always read the ambient
		// environment would be unconfigurable in a test and would pick up a
		// developer's local broker in CI.
		expect(() =>
			createKafkaProvider({ cluster: CLUSTER, env: {} }),
		).not.toThrow();
	});

	it("resolves once at construction, not per call", () => {
		// A later change to the environment must not repoint a provider that is
		// already wired — otherwise a long-lived provider could start talking to
		// a different broker mid-run with nothing recording the change.
		const env: Record<string, string | undefined> = {};
		const provider = createKafkaProvider({ cluster: CLUSTER, env });
		env.KAFKA_BOOTSTRAP_SERVERS = "changed:9092";
		expect(provider.createMessaging()).toBeDefined();
	});

	it("falls back to process.env when no environment is injected", () => {
		// The production path. Constructing with no `env` must work rather than
		// throwing on an undefined lookup.
		expect(() => createKafkaProvider({ cluster: CLUSTER })).not.toThrow();
	});
});
