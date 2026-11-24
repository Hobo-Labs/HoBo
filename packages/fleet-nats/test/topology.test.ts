import { DiscardPolicy } from "@nats-io/jetstream";
import { describe, expect, it } from "vitest";
import { connectionOptions, parseServers } from "../src/bus/connection.js";
import { topologySpecs } from "../src/bus/topology.js";
import {
	JOURNAL_STREAM_CONFIG,
	JOURNAL_SUBJECTS,
} from "../src/journal/codec.js";

const SECOND_NS = 1_000_000_000;

describe("topology (§6.7)", () => {
	const specs = topologySpecs(3);
	const named = (name: string) => {
		const spec = specs.find((candidate) => candidate.name === name);
		if (spec === undefined) throw new Error(`no stream ${name}`);
		return spec;
	};

	it("creates every stream and bucket of §6.7 with the profile's replicas", () => {
		expect(specs.map((spec) => spec.name).sort()).toEqual([
			"FLEET_AUDIT",
			"FLEET_CLAIMS",
			"FLEET_CONTROL",
			"FLEET_EVENTS",
			"FLEET_JOURNAL",
			"FLEET_OFFERS",
			"FLEET_ORDERS",
			"FLEET_SUBMISSIONS",
			"KV_fleet-observations",
			"KV_fleet-registry",
			"KV_fleet-replay",
			"KV_fleet-views",
		]);
		expect(specs.every((spec) => spec.num_replicas === 3)).toBe(true);
		expect(topologySpecs(1).every((spec) => spec.num_replicas === 1)).toBe(
			true,
		);
	});

	it("makes claims first-writer-wins at the server, with no purge or rollup (E5, A5)", () => {
		const claims = named("FLEET_CLAIMS");
		expect(claims).toMatchObject({
			subjects: ["fleet.claim.*.*"],
			max_age: 120 * SECOND_NS,
			max_msgs_per_subject: 1,
			discard: DiscardPolicy.New,
			discard_new_per_subject: true,
			deny_purge: true,
			allow_rollup_hdrs: false,
			allow_direct: true,
		});
	});

	it("keeps the event, journal and audit streams append-only", () => {
		for (const name of ["FLEET_EVENTS", "FLEET_JOURNAL", "FLEET_AUDIT"])
			expect(named(name)).toMatchObject({
				deny_delete: true,
				deny_purge: true,
			});
		expect(named("FLEET_AUDIT").subjects).toEqual([
			"fleet.audit.entry",
			"fleet.audit.checkpoint",
			"fleet.audit.trust",
			"fleet.audit.witness",
		]);
		expect(named("FLEET_JOURNAL").max_age).toBe(0);
	});

	it("provisions FLEET_JOURNAL with the journal store's own stream configuration (L36)", () => {
		const journal = named("FLEET_JOURNAL");
		expect(journal).toMatchObject(JOURNAL_STREAM_CONFIG);
		expect(journal.subjects).toEqual([JOURNAL_SUBJECTS]);
		expect(journal.num_replicas).toBe(3);
		expect(JOURNAL_STREAM_CONFIG).toMatchObject({
			name: "FLEET_JOURNAL",
			subjects: ["fleet.journal.>"],
			discard: DiscardPolicy.New,
			max_age: 0,
			deny_delete: true,
			deny_purge: true,
		});
	});

	it("sets the bucket histories and TTLs", () => {
		expect(named("KV_fleet-registry")).toMatchObject({
			max_msgs_per_subject: 5,
			max_age: 0,
		});
		expect(named("KV_fleet-views")).toMatchObject({
			max_msgs_per_subject: 1,
			max_age: 120 * SECOND_NS,
		});
		expect(named("KV_fleet-observations")).toMatchObject({
			max_age: 60 * SECOND_NS,
		});
		expect(named("KV_fleet-replay")).toMatchObject({
			max_age: 300 * SECOND_NS,
			allow_msg_ttl: true,
		});
	});
});

describe("connections", () => {
	it("accepts tls:// and nats:// server URLs only and always requires TLS", () => {
		expect(parseServers(["tls://a.example:4222", "nats://b:4222"])).toEqual([
			"nats://a.example:4222",
			"nats://b:4222",
		]);
		expect(() => parseServers([])).toThrow();
		expect(() => parseServers(["ws://a:80"])).toThrow();
		expect(() => parseServers(["http://a"])).toThrow();
		const options = connectionOptions({
			servers: ["tls://a:4222"],
			authenticator: () => ({ auth_token: "t" }),
			name: "x",
			inboxPrefix: "_INBOX.dev_1",
			persistent: true,
		});
		expect(options.tls).toBeDefined();
		expect(options.inboxPrefix).toBe("_INBOX.dev_1");
		expect(options.maxReconnectAttempts).toBe(-1);
	});
});
