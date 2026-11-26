/**
 * The Kafka resource parse boundary.
 *
 * Two things here are load-bearing beyond ordinary shape checking.
 *
 * **Secretless-first is enforced at the parse, not by convention.** A cluster
 * spec that carries a `password`, `saslPassword`, `apiSecret`,
 * `secretAccessKey` or `plaintextCredential` is *refused*, because the
 * alternative is worse than it sounds: a spec is a record that gets written
 * down, diffed into plans, and echoed into receipts. Accepting a plaintext
 * credential once puts it in all of those, and no amount of later redaction
 * gets it back out. The spec references a binding instead, and the binding is
 * resolved at use.
 *
 * **The topic bounds are guards against a silently wrong cluster.** A
 * `partitions` of 0 or a `replicationFactor` of 0 is not a smaller topic — it
 * is a topic that cannot accept a write or cannot survive a broker loss. Both
 * are refused rather than clamped, because clamping would deploy something the
 * author did not ask for and did not get told about.
 */
import { MessagingParseError } from "@hobo/core";
import { describe, expect, it } from "vitest";

import {
	parseKafkaClusterKind,
	parseKafkaClusterSpec,
	parseKafkaResourceDefinition,
	parseKafkaTopicResource,
} from "../src/parse.js";

const CLUSTER = {
	name: "events",
	tenantId: "acme",
	kind: "redpanda",
	bootstrapServers: ["broker-1:9092"],
};

const TOPIC = {
	name: "orders",
	cluster: "events",
	tenantId: "acme",
	partitions: 3,
	replicationFactor: 2,
};

function fieldOf(thunk: () => unknown): string {
	try {
		thunk();
	} catch (error) {
		expect(error).toBeInstanceOf(MessagingParseError);
		return (
			(error as { path?: string; field?: string }).path ??
			(error as { field?: string }).field ??
			(error as Error).message
		);
	}
	return expect.unreachable("expected a MessagingParseError") as never;
}

describe("parseKafkaClusterKind", () => {
	it("accepts every declared kind", () => {
		for (const kind of [
			"self-hosted",
			"redpanda",
			"msk",
			"confluent",
			"azure-event-hubs",
			"local-emulator",
		]) {
			expect(parseKafkaClusterKind(kind)).toBe(kind);
		}
	});

	it("refuses an undeclared kind and lists the alternatives", () => {
		// The kind decides which transport and which credential exchange apply.
		// Accepting an unknown one would pick a default silently and connect to
		// the wrong sort of cluster.
		expect(fieldOf(() => parseKafkaClusterKind("pulsar"))).toContain("kind");
		expect(() => parseKafkaClusterKind("")).toThrow(MessagingParseError);
		expect(() => parseKafkaClusterKind(7)).toThrow(MessagingParseError);
		expect(() => parseKafkaClusterKind(undefined)).toThrow(MessagingParseError);
	});

	it("matches exactly, including case", () => {
		expect(() => parseKafkaClusterKind("Redpanda")).toThrow(
			MessagingParseError,
		);
	});
});

describe("parseKafkaClusterSpec — secretless-first", () => {
	it("refuses every forbidden plaintext credential key", () => {
		// The whole point. A spec is written down, diffed into plans and echoed
		// into receipts; accepting a plaintext credential once puts it in all of
		// them, and later redaction cannot get it back out.
		for (const forbidden of [
			"password",
			"saslPassword",
			"apiSecret",
			"secretAccessKey",
			"plaintextCredential",
		]) {
			expect(
				fieldOf(() =>
					parseKafkaClusterSpec({ ...CLUSTER, [forbidden]: "hunter2" }),
				),
			).toContain(forbidden);
		}
	});

	it("refuses a forbidden key even when its value is empty or null", () => {
		// `forbidden in src`, not a truthiness check. A key present with an empty
		// value still says the author intended to put a credential there, and
		// accepting it would teach exactly the pattern the guard exists to stop.
		for (const value of ["", null, undefined, 0, false]) {
			expect(() =>
				parseKafkaClusterSpec({ ...CLUSTER, password: value }),
			).toThrow(MessagingParseError);
		}
	});

	it("defaults the credential binding reference", () => {
		// `fromBinding:kafka`. A spec that named no binding is not credential-less
		// — it uses the conventional one — so defaulting keeps the common case
		// terse without inviting a literal.
		expect(parseKafkaClusterSpec(CLUSTER).credentialBindingRef).toBe(
			"fromBinding:kafka",
		);
	});

	it("honours an explicit binding reference in either spelling", () => {
		expect(
			parseKafkaClusterSpec({
				...CLUSTER,
				credentialBindingRef: "fromBinding:x",
			}).credentialBindingRef,
		).toBe("fromBinding:x");
		expect(
			parseKafkaClusterSpec({
				...CLUSTER,
				credential_binding_ref: "fromBinding:y",
			}).credentialBindingRef,
		).toBe("fromBinding:y");
	});

	it("refuses an empty binding reference", () => {
		// An empty ref resolves to nothing, and a connection attempt with no
		// credential would fail at the broker rather than at the parse.
		expect(() =>
			parseKafkaClusterSpec({ ...CLUSTER, credentialBindingRef: "" }),
		).toThrow(MessagingParseError);
	});
});

describe("parseKafkaClusterSpec — shape", () => {
	it("parses a well-formed spec and freezes it", () => {
		const spec = parseKafkaClusterSpec(CLUSTER);
		expect(spec.name).toBe("events");
		expect(spec.tenantId).toBe("acme");
		expect(spec.kind).toBe("redpanda");
		expect(spec.bootstrapServers).toEqual(["broker-1:9092"]);
		expect(Object.isFrozen(spec)).toBe(true);
	});

	it("refuses a non-object", () => {
		for (const bad of [null, undefined, 7, "spec"]) {
			expect(() => parseKafkaClusterSpec(bad)).toThrow(MessagingParseError);
		}
	});

	it("requires a name and a tenant", () => {
		// The tenant scopes every topic and consumer group derived from this
		// cluster. An empty one would put a tenant's traffic in a shared
		// namespace.
		expect(
			fieldOf(() => parseKafkaClusterSpec({ ...CLUSTER, name: "" })),
		).toContain("name");
		expect(
			fieldOf(() => parseKafkaClusterSpec({ ...CLUSTER, tenantId: undefined })),
		).toContain("tenantId");
	});

	it("accepts the snake_case tenant spelling", () => {
		const { tenantId, ...rest } = CLUSTER;
		expect(parseKafkaClusterSpec({ ...rest, tenant_id: "acme" }).tenantId).toBe(
			"acme",
		);
	});

	it("defaults the kind to self-hosted", () => {
		const { kind, ...rest } = CLUSTER;
		expect(parseKafkaClusterSpec(rest).kind).toBe("self-hosted");
	});

	it("accepts either bootstrap-server spelling", () => {
		const { bootstrapServers, ...rest } = CLUSTER;
		expect(
			parseKafkaClusterSpec({ ...rest, bootstrap_servers: ["b:9092"] })
				.bootstrapServers,
		).toEqual(["b:9092"]);
	});

	it("treats a missing or non-array server list as empty", () => {
		// Empty rather than a throw: a cluster whose brokers are discovered at
		// bind time is legitimate, and refusing here would make that unauthorable.
		const { bootstrapServers, ...rest } = CLUSTER;
		expect(parseKafkaClusterSpec(rest).bootstrapServers).toEqual([]);
		expect(
			parseKafkaClusterSpec({ ...rest, bootstrapServers: "b:9092" })
				.bootstrapServers,
		).toEqual([]);
	});

	it("refuses an empty entry inside the server list", () => {
		// An empty broker address would be dialled as-is and fail with a message
		// about a connection rather than about a malformed spec.
		expect(() =>
			parseKafkaClusterSpec({ ...CLUSTER, bootstrapServers: ["b:9092", ""] }),
		).toThrow(MessagingParseError);
	});

	it("defaults idempotentProducer on and transactional off", () => {
		// Idempotent producing is on by default because a duplicate write is the
		// failure mode that costs money and is hardest to detect; transactions
		// are off because they change delivery semantics an author should opt
		// into deliberately.
		const spec = parseKafkaClusterSpec(CLUSTER);
		expect(spec.idempotentProducer).toBe(true);
		expect(spec.transactional).toBe(false);
	});

	it("lets an author turn idempotent producing off explicitly", () => {
		expect(
			parseKafkaClusterSpec({ ...CLUSTER, idempotentProducer: false })
				.idempotentProducer,
		).toBe(false);
		expect(
			parseKafkaClusterSpec({ ...CLUSTER, idempotent_producer: false })
				.idempotentProducer,
		).toBe(false);
	});

	it("omits the schema registry reference when none is given", () => {
		// Conditional spread, so absent stays absent rather than becoming a
		// present `undefined` that a consumer would try to resolve.
		expect(
			Object.hasOwn(parseKafkaClusterSpec(CLUSTER), "schemaRegistryRef"),
		).toBe(false);
	});

	it("carries a schema registry reference in either spelling", () => {
		expect(
			parseKafkaClusterSpec({ ...CLUSTER, schemaRegistryRef: "sr://x" })
				.schemaRegistryRef,
		).toBe("sr://x");
		expect(
			parseKafkaClusterSpec({ ...CLUSTER, schema_registry_ref: "sr://y" })
				.schemaRegistryRef,
		).toBe("sr://y");
	});

	it("copies the labels rather than aliasing the caller's object", () => {
		// A spread. Aliasing would let a caller mutate a frozen spec's labels
		// through the object they passed in.
		const labels = { team: "platform" };
		const spec = parseKafkaClusterSpec({ ...CLUSTER, labels });
		labels.team = "changed";
		expect(spec.labels).toEqual({ team: "platform" });
	});

	it("omits labels when none are given or they are not an object", () => {
		expect(Object.hasOwn(parseKafkaClusterSpec(CLUSTER), "labels")).toBe(false);
		expect(
			Object.hasOwn(
				parseKafkaClusterSpec({ ...CLUSTER, labels: "a" }),
				"labels",
			),
		).toBe(false);
	});
});

describe("parseKafkaTopicResource", () => {
	it("parses a well-formed topic and freezes it", () => {
		const topic = parseKafkaTopicResource(TOPIC);
		expect(topic.name).toBe("orders");
		expect(topic.cluster).toBe("events");
		expect(topic.partitions).toBe(3);
		expect(topic.replicationFactor).toBe(2);
		expect(Object.isFrozen(topic)).toBe(true);
	});

	it("refuses a non-object", () => {
		for (const bad of [null, undefined, 7, "topic"]) {
			expect(() => parseKafkaTopicResource(bad)).toThrow(MessagingParseError);
		}
	});

	it("requires a name, a cluster and a tenant", () => {
		// The cluster is what the topic is created on. An empty one would be
		// looked up, miss, and be reported as a missing cluster rather than as a
		// malformed topic.
		for (const field of ["name", "cluster", "tenantId"] as const) {
			expect(() => parseKafkaTopicResource({ ...TOPIC, [field]: "" })).toThrow(
				MessagingParseError,
			);
		}
	});

	it("defaults partitions and replication factor to one", () => {
		const { partitions, replicationFactor, ...rest } = TOPIC;
		const topic = parseKafkaTopicResource(rest);
		expect(topic.partitions).toBe(1);
		expect(topic.replicationFactor).toBe(1);
	});

	it("refuses a partition count below one", () => {
		// Refused, not clamped. A zero-partition topic cannot accept a write, and
		// silently deploying a one-partition topic instead would give the author
		// something they did not ask for without telling them.
		for (const partitions of [0, -1]) {
			expect(
				fieldOf(() => parseKafkaTopicResource({ ...TOPIC, partitions })),
			).toContain("partitions");
		}
	});

	it("refuses a fractional or non-numeric partition count", () => {
		// `Number()` coerces before the integer check, so `"3"` is fine but
		// `"three"` becomes NaN — which would otherwise be passed to the broker
		// and produce a topic with an unpredictable layout.
		for (const partitions of [1.5, "three", {}]) {
			expect(() => parseKafkaTopicResource({ ...TOPIC, partitions })).toThrow(
				MessagingParseError,
			);
		}
	});

	it("treats an explicit null partition count as absent", () => {
		// `src.partitions ?? 1` is nullish coalescing, so `null` takes the default
		// rather than coercing to `Number(null) === 0` and being refused. Pinned
		// because the two readings differ: a JSON document that serialised an
		// unset field as `null` gets a one-partition topic, not an error. That is
		// the friendlier behaviour and the one a round-tripped document needs.
		expect(
			parseKafkaTopicResource({ ...TOPIC, partitions: null }).partitions,
		).toBe(1);
		expect(
			parseKafkaTopicResource({ ...TOPIC, replicationFactor: null })
				.replicationFactor,
		).toBe(1);
	});

	it("accepts a numeric string for the counts", () => {
		const topic = parseKafkaTopicResource({
			...TOPIC,
			partitions: "6",
			replicationFactor: "3",
		});
		expect(topic.partitions).toBe(6);
		expect(topic.replicationFactor).toBe(3);
	});

	it("refuses a replication factor below one", () => {
		// A replication factor of zero is a topic that cannot survive a single
		// broker loss — the durability property the author almost certainly
		// believed they had.
		for (const rf of [0, -1, 1.5]) {
			expect(() =>
				parseKafkaTopicResource({ ...TOPIC, replicationFactor: rf }),
			).toThrow(MessagingParseError);
		}
	});

	it("accepts either replication-factor spelling", () => {
		const { replicationFactor, ...rest } = TOPIC;
		expect(
			parseKafkaTopicResource({ ...rest, replication_factor: 3 })
				.replicationFactor,
		).toBe(3);
	});

	it("defaults the delivery guarantee to at-least-once", () => {
		// The safe default for a broker: at-most-once silently drops, and
		// exactly-once needs transactional support the cluster may not have.
		expect(parseKafkaTopicResource(TOPIC).deliveryGuarantee).toBe(
			"at-least-once",
		);
	});

	it("accepts an explicit delivery guarantee in either spelling", () => {
		expect(
			parseKafkaTopicResource({ ...TOPIC, deliveryGuarantee: "at-most-once" })
				.deliveryGuarantee,
		).toBe("at-most-once");
		expect(
			parseKafkaTopicResource({ ...TOPIC, delivery_guarantee: "at-most-once" })
				.deliveryGuarantee,
		).toBe("at-most-once");
	});

	it("refuses an unrecognised delivery guarantee", () => {
		// Delegated to core's parser, so a typo does not silently become the
		// default and change what the topic promises.
		expect(() =>
			parseKafkaTopicResource({ ...TOPIC, deliveryGuarantee: "maybe-once" }),
		).toThrow();
	});

	it("omits the dead-letter topic and schema ref when absent", () => {
		const topic = parseKafkaTopicResource(TOPIC);
		expect(Object.hasOwn(topic, "deadLetterTopic")).toBe(false);
		expect(Object.hasOwn(topic, "schemaRef")).toBe(false);
	});

	it("carries the dead-letter topic and schema ref in either spelling", () => {
		expect(
			parseKafkaTopicResource({ ...TOPIC, deadLetterTopic: "orders.dlq" })
				.deadLetterTopic,
		).toBe("orders.dlq");
		expect(
			parseKafkaTopicResource({ ...TOPIC, dead_letter_topic: "o.dlq" })
				.deadLetterTopic,
		).toBe("o.dlq");
		expect(
			parseKafkaTopicResource({ ...TOPIC, schemaRef: "s://x" }).schemaRef,
		).toBe("s://x");
		expect(
			parseKafkaTopicResource({ ...TOPIC, schema_ref: "s://y" }).schemaRef,
		).toBe("s://y");
	});
});

describe("parseKafkaResourceDefinition", () => {
	const CLUSTER_DEF = {
		apiVersion: "hobo.kafka/v1",
		kind: "KafkaCluster",
		name: "events",
		tenantId: "acme",
		spec: { kind: "redpanda", bootstrapServers: ["b:9092"] },
	};

	const TOPIC_DEF = {
		apiVersion: "hobo.kafka/v1",
		kind: "KafkaTopic",
		name: "orders",
		tenantId: "acme",
		spec: { cluster: "events", partitions: 3, replicationFactor: 2 },
	};

	it("parses a cluster definition", () => {
		const definition = parseKafkaResourceDefinition(CLUSTER_DEF);
		expect(definition.kind).toBe("KafkaCluster");
		expect(definition.name).toBe("events");
	});

	it("parses a topic definition", () => {
		const definition = parseKafkaResourceDefinition(TOPIC_DEF);
		expect(definition.kind).toBe("KafkaTopic");
		expect(definition.name).toBe("orders");
	});

	it("refuses a non-object", () => {
		for (const bad of [null, undefined, 7, "def"]) {
			expect(() => parseKafkaResourceDefinition(bad)).toThrow(
				MessagingParseError,
			);
		}
	});

	it("pins the api version exactly", () => {
		// A version this parser does not implement must not be interpreted as
		// though it were the one it does — that is how a field silently changes
		// meaning between releases.
		for (const apiVersion of ["hobo.kafka/v2", "hobo.kafka", "v1", ""]) {
			expect(() =>
				parseKafkaResourceDefinition({ ...CLUSTER_DEF, apiVersion }),
			).toThrow(MessagingParseError);
		}
	});

	it("accepts the snake_case api version spelling", () => {
		const { apiVersion, ...rest } = CLUSTER_DEF;
		expect(
			parseKafkaResourceDefinition({ ...rest, api_version: "hobo.kafka/v1" })
				.kind,
		).toBe("KafkaCluster");
	});

	it("refuses a kind it does not implement", () => {
		for (const kind of ["KafkaConsumerGroup", "Topic", ""]) {
			expect(() =>
				parseKafkaResourceDefinition({ ...CLUSTER_DEF, kind }),
			).toThrow(MessagingParseError);
		}
	});

	it("reads the name and tenant from metadata when not at the top level", () => {
		// Kubernetes-shaped documents put both under `metadata`. Supporting only
		// the flat form would make a copied manifest unparseable for a reason
		// that has nothing to do with its content.
		const definition = parseKafkaResourceDefinition({
			apiVersion: "hobo.kafka/v1",
			kind: "KafkaCluster",
			metadata: { name: "events", tenantId: "acme" },
			spec: { kind: "redpanda" },
		});
		expect(definition.name).toBe("events");
	});

	it("prefers a top-level name over the metadata one", () => {
		expect(
			parseKafkaResourceDefinition({
				...CLUSTER_DEF,
				metadata: { name: "other" },
			}).name,
		).toBe("events");
	});

	it("requires a name and a tenant from somewhere", () => {
		const { name, ...noName } = CLUSTER_DEF;
		expect(() => parseKafkaResourceDefinition(noName)).toThrow(
			MessagingParseError,
		);
		const { tenantId, ...noTenant } = CLUSTER_DEF;
		expect(() => parseKafkaResourceDefinition(noTenant)).toThrow(
			MessagingParseError,
		);
	});

	it("falls back to the document itself when there is no spec block", () => {
		// `src.spec ?? src`. A flat document is a legitimate authoring shape, and
		// requiring a wrapper would reject it for no reason.
		const definition = parseKafkaResourceDefinition({
			apiVersion: "hobo.kafka/v1",
			kind: "KafkaTopic",
			name: "orders",
			tenantId: "acme",
			cluster: "events",
		});
		expect(definition.kind).toBe("KafkaTopic");
	});

	it("still refuses a plaintext credential nested in a spec block", () => {
		// The secretless guard has to survive the outer wrapper, or the whole
		// protection would be one level of nesting away from being bypassed.
		expect(() =>
			parseKafkaResourceDefinition({
				...CLUSTER_DEF,
				spec: { ...CLUSTER_DEF.spec, password: "hunter2" },
			}),
		).toThrow(MessagingParseError);
	});

	it("overrides a spec-level name with the definition's own", () => {
		// The definition's identity wins, so a spec whose `name` disagrees cannot
		// produce a resource addressed differently from the document that
		// declared it.
		const definition = parseKafkaResourceDefinition({
			...CLUSTER_DEF,
			spec: { ...CLUSTER_DEF.spec, name: "different" },
		});
		expect(definition.name).toBe("events");
	});
});
