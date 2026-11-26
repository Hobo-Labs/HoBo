/**
 * The declarative conformance suite for Redis-compatible key/value storage.
 *
 * Scope is deliberately narrow. These cases establish command transport, the
 * key/value data types, TTL and expiry, the atomic operations the profile
 * promises, behaviour at a declared payload bound, and the consistency the
 * implementation can actually be held to from a single client. They establish
 * nothing about delivery: no case here can be cited as evidence for a queue or
 * topic profile, and `substantiates` is the machine-readable form of that.
 */
import type { CommandTemplate, ReplyExpectation } from "./protocol.js";

export const CONFORMANCE_AREAS = [
	"transport",
	"key-value",
	"ttl",
	"atomicity",
	"bounded-payload",
	"consistency",
] as const;

export type ConformanceArea = (typeof CONFORMANCE_AREAS)[number];

// parallel-type-allowed: the authored step holds a `CommandTemplate` tuple whose first element is the verb, a constraint proto3's repeated field cannot carry; the proto ConformanceStep is its wire projection.
export type ConformanceStep = {
	readonly command: CommandTemplate;
	readonly expect: ReplyExpectation;
	/** Milliseconds of implementation time to pass before this step runs. */
	readonly waitMs?: number;
};

// parallel-type-allowed: the authored case narrows `profileId` to the two kv profiles as a literal union, which is what keeps a queue profile unrepresentable; the proto ConformanceCase is its wire projection.
export type ConformanceCase = {
	readonly id: string;
	readonly area: ConformanceArea;
	/** The profile this case is evidence for. Never a queue or topic profile. */
	readonly profileId: "kv.key-value/v1" | "kv.redis-compatible/v1";
	readonly title: string;
	/** Why the case exists, in terms of what breaks without it. */
	readonly rationale: string;
	readonly steps: readonly ConformanceStep[];
	/**
	 * Structured capability keys this case substantiates when it passes. A
	 * capability with no passing case is never reported as substantiated.
	 */
	readonly substantiates: readonly string[];
	/** Optional cases never fail a run; they are reported and skipped. */
	readonly optional?: boolean;
};

const key = (suffix: string): string => `hobo:conf:${suffix}`;

const OK: ReplyExpectation = { kind: "value", value: "OK" };
const NIL: ReplyExpectation = { kind: "value", value: null };
const value = (v: string | number): ReplyExpectation => ({
	kind: "value",
	value: v,
});

const TRANSPORT: readonly ConformanceCase[] = [
	{
		id: "transport.liveness",
		area: "transport",
		profileId: "kv.key-value/v1",
		title: "The command transport answers PING",
		rationale:
			"Everything below assumes a command reached the server and a reply came back. If PING does not answer, every other failure in the run is unattributable.",
		steps: [
			{ command: ["PING"], expect: { kind: "one-of", values: ["PONG", "OK"] } },
		],
		substantiates: [],
	},
	{
		id: "transport.utf8-round-trip",
		area: "transport",
		profileId: "kv.key-value/v1",
		title: "Non-ASCII arguments survive the transport",
		rationale:
			"A REST transport that URL-encodes arguments can mangle multi-byte text. Application values are frequently JSON with non-ASCII content, so this is a correctness boundary, not a nicety.",
		steps: [
			{
				command: ["ECHO", "héllo · wörld ✓"],
				expect: value("héllo · wörld ✓"),
			},
		],
		substantiates: [],
	},
	{
		id: "transport.unknown-command-is-an-error",
		area: "transport",
		profileId: "kv.redis-compatible/v1",
		title: "An unsupported command produces an error reply, not a value",
		rationale:
			"A transport that turns an unknown command into a null value makes every negative assertion in this suite meaningless, because a rejection and an empty result become indistinguishable.",
		steps: [
			{ command: ["HOBO_NOT_A_REDIS_COMMAND"], expect: { kind: "error" } },
		],
		substantiates: [],
	},
];

const KEY_VALUE: readonly ConformanceCase[] = [
	{
		id: "key-value.string-round-trip",
		area: "key-value",
		profileId: "kv.key-value/v1",
		title: "SET then GET returns the stored string",
		rationale:
			"The minimum a key/value store means. If this case fails nothing further in the run is worth reading.",
		steps: [
			{ command: ["SET", key("kv:string"), "first-value"], expect: OK },
			{ command: ["GET", key("kv:string")], expect: value("first-value") },
		],
		substantiates: [],
	},
	{
		id: "key-value.missing-key-is-nil",
		area: "key-value",
		profileId: "kv.key-value/v1",
		title: "A key that was never written reads as nil",
		rationale:
			"Absence must be distinguishable from an empty string; a caller that cannot tell them apart cannot implement a cache miss.",
		steps: [{ command: ["GET", key("kv:never-written")], expect: NIL }],
		substantiates: [],
	},
	{
		id: "key-value.overwrite-and-delete",
		area: "key-value",
		profileId: "kv.key-value/v1",
		title: "A key can be overwritten and deleted, and DEL reports what it did",
		rationale:
			"DEL returning the number of keys removed is what makes delete-once logic possible without a read-modify-write race.",
		steps: [
			{ command: ["SET", key("kv:lifecycle"), "one"], expect: OK },
			{ command: ["SET", key("kv:lifecycle"), "two"], expect: OK },
			{ command: ["GET", key("kv:lifecycle")], expect: value("two") },
			{ command: ["DEL", key("kv:lifecycle")], expect: value(1) },
			{ command: ["GET", key("kv:lifecycle")], expect: NIL },
			{ command: ["DEL", key("kv:lifecycle")], expect: value(0) },
		],
		substantiates: [],
	},
	{
		id: "key-value.exists-and-type",
		area: "key-value",
		profileId: "kv.redis-compatible/v1",
		title: "EXISTS and TYPE report Redis-shaped answers",
		rationale:
			"TYPE returning the Redis type name is a cheap, load-bearing signal that this is Redis semantics rather than an HTTP map with GET and SET bolted on.",
		steps: [
			{ command: ["SET", key("kv:typed"), "a-string"], expect: OK },
			{ command: ["EXISTS", key("kv:typed")], expect: value(1) },
			{ command: ["TYPE", key("kv:typed")], expect: value("string") },
		],
		substantiates: ["redisCommandSemantics"],
	},
	{
		id: "key-value.binary-safe-value",
		area: "key-value",
		profileId: "kv.key-value/v1",
		title:
			"A JSON blob with quotes, braces, and a newline round-trips byte-for-byte",
		rationale:
			"The dominant real payload is serialized JSON. A transport that escapes or trims it corrupts application state silently.",
		steps: [
			{
				command: [
					"SET",
					key("kv:blob"),
					'{"step":2,"note":"line one\nline two","q":"\\""}',
				],
				expect: OK,
			},
			{
				command: ["GET", key("kv:blob")],
				expect: value('{"step":2,"note":"line one\nline two","q":"\\""}'),
			},
		],
		substantiates: [],
	},
	{
		id: "key-value.list-data-type",
		area: "key-value",
		profileId: "kv.redis-compatible/v1",
		title: "Lists behave as an ordered collection data type",
		rationale:
			"Lists are a stored data structure. This case is evidence for the Redis data-type surface and for nothing else — see KV_REDIS_NON_IMPLIED_PROFILES. It establishes no delivery guarantee, no acknowledgement, no redelivery, and no visibility timeout, so it can never be cited for queue.at-least-once/v1.",
		steps: [
			{ command: ["RPUSH", key("kv:list"), "a"], expect: value(1) },
			{ command: ["RPUSH", key("kv:list"), "b"], expect: value(2) },
			{
				command: ["LRANGE", key("kv:list"), "0", "-1"],
				expect: { kind: "value", value: ["a", "b"] },
			},
			{ command: ["LPOP", key("kv:list")], expect: value("a") },
			{ command: ["LLEN", key("kv:list")], expect: value(1) },
		],
		substantiates: ["redisCommandSemantics"],
	},
	{
		id: "key-value.hash-data-type",
		area: "key-value",
		profileId: "kv.redis-compatible/v1",
		title: "Hashes store and read named fields",
		rationale:
			"Field-level reads are what let a caller avoid a read-modify-write cycle over a whole document.",
		steps: [
			{ command: ["HSET", key("kv:hash"), "name", "joe"], expect: value(1) },
			{ command: ["HGET", key("kv:hash"), "name"], expect: value("joe") },
			{ command: ["HGET", key("kv:hash"), "absent"], expect: NIL },
		],
		substantiates: ["redisCommandSemantics"],
	},
	{
		id: "key-value.sorted-set",
		area: "key-value",
		profileId: "kv.redis-compatible/v1",
		title: "Sorted sets order members by score",
		rationale:
			"Score-ordered recall is the one Redis structure with no plain key/value equivalent, so it is the sharpest test of whether the implementation is Redis or an impersonation.",
		steps: [
			{ command: ["ZADD", key("kv:zset"), "2", "second"], expect: value(1) },
			{ command: ["ZADD", key("kv:zset"), "1", "first"], expect: value(1) },
			{
				command: ["ZRANGE", key("kv:zset"), "0", "-1"],
				expect: { kind: "value", value: ["first", "second"] },
			},
			{ command: ["ZSCORE", key("kv:zset"), "second"], expect: value(2) },
		],
		substantiates: ["sortedSets", "redisCommandSemantics"],
	},
];

const TTL: readonly ConformanceCase[] = [
	{
		id: "ttl.set-with-expiry-reports-remaining",
		area: "ttl",
		profileId: "kv.key-value/v1",
		title: "SET ... EX records an expiry that TTL reports back",
		rationale:
			"A store that accepts EX and silently discards it produces a cache that never evicts. Reading the TTL back is the only way to tell from outside.",
		steps: [
			{ command: ["SET", key("ttl:with-ex"), "v", "EX", "60"], expect: OK },
			{
				command: ["TTL", key("ttl:with-ex")],
				expect: { kind: "integer-between", min: 1, max: 60 },
			},
		],
		substantiates: ["ttl"],
	},
	{
		id: "ttl.no-expiry-reports-minus-one",
		area: "ttl",
		profileId: "kv.key-value/v1",
		title: "A key with no expiry reports TTL -1",
		rationale:
			"Redis distinguishes 'no expiry' (-1) from 'no such key' (-2). Collapsing them hides leaked keys.",
		steps: [
			{ command: ["SET", key("ttl:persistent"), "v"], expect: OK },
			{ command: ["TTL", key("ttl:persistent")], expect: value(-1) },
			{ command: ["TTL", key("ttl:absent")], expect: value(-2) },
		],
		substantiates: ["ttl"],
	},
	{
		id: "ttl.persist-clears-expiry",
		area: "ttl",
		profileId: "kv.redis-compatible/v1",
		title: "PERSIST removes an expiry that was already set",
		rationale:
			"Extending a lease by clearing its expiry is a common pattern; without PERSIST a caller has to rewrite the value and risks losing a concurrent update.",
		steps: [
			{ command: ["SET", key("ttl:persist"), "v", "EX", "60"], expect: OK },
			{ command: ["PERSIST", key("ttl:persist")], expect: value(1) },
			{ command: ["TTL", key("ttl:persist")], expect: value(-1) },
		],
		substantiates: ["ttl"],
	},
	{
		id: "ttl.key-actually-expires",
		area: "ttl",
		profileId: "kv.key-value/v1",
		title: "A key with a short expiry is gone once the expiry passes",
		rationale:
			"Reporting a TTL is not the same as honouring one. This is the only case that proves eviction happens, and it is the reason the executor is allowed to control time.",
		steps: [
			{ command: ["SET", key("ttl:short"), "v", "PX", "50"], expect: OK },
			{ command: ["GET", key("ttl:short")], expect: value("v") },
			{ command: ["GET", key("ttl:short")], expect: NIL, waitMs: 250 },
		],
		substantiates: ["ttl"],
	},
];

const ATOMICITY: readonly ConformanceCase[] = [
	{
		id: "atomicity.incr-counter",
		area: "atomicity",
		profileId: "kv.redis-compatible/v1",
		title: "INCR and INCRBY advance a counter server-side",
		rationale:
			"A counter implemented as GET-then-SET loses updates under concurrency. INCR is the reason a Redis-compatible store can be used as a rate limiter at all.",
		steps: [
			{ command: ["INCR", key("atomic:counter")], expect: value(1) },
			{ command: ["INCR", key("atomic:counter")], expect: value(2) },
			{ command: ["INCRBY", key("atomic:counter"), "5"], expect: value(7) },
			{ command: ["GET", key("atomic:counter")], expect: value("7") },
		],
		substantiates: ["atomicIncrement", "redisCommandSemantics"],
	},
	{
		id: "atomicity.incr-rejects-non-integer",
		area: "atomicity",
		profileId: "kv.redis-compatible/v1",
		title: "INCR on a non-integer value is rejected rather than coerced",
		rationale:
			"An implementation that coerces 'abc' to 0 and increments it destroys data and reports success. Rejection is the correct Redis behaviour.",
		steps: [
			{ command: ["SET", key("atomic:not-a-number"), "abc"], expect: OK },
			{
				command: ["INCR", key("atomic:not-a-number")],
				expect: { kind: "error" },
			},
			{ command: ["GET", key("atomic:not-a-number")], expect: value("abc") },
		],
		substantiates: ["atomicIncrement"],
	},
	{
		id: "atomicity.set-nx-succeeds-once",
		area: "atomicity",
		profileId: "kv.redis-compatible/v1",
		title: "SET ... NX creates a key exactly once",
		rationale:
			"Create-if-absent is the primitive every distributed lock and every exactly-once-ish guard is built on. Without it the store cannot arbitrate anything.",
		steps: [
			{ command: ["SET", key("atomic:lock"), "owner-a", "NX"], expect: OK },
			{ command: ["SET", key("atomic:lock"), "owner-b", "NX"], expect: NIL },
			{ command: ["GET", key("atomic:lock")], expect: value("owner-a") },
		],
		substantiates: ["atomicCompareAndSet", "redisCommandSemantics"],
	},
	{
		id: "atomicity.set-nx-with-expiry",
		area: "atomicity",
		profileId: "kv.redis-compatible/v1",
		title: "SET ... NX EX takes the lock and its expiry in one command",
		rationale:
			"A lock taken in one command and expired in a second one leaks forever if the caller dies in between. The combined form is the only safe one.",
		steps: [
			{
				command: ["SET", key("atomic:lease"), "owner-a", "NX", "EX", "60"],
				expect: OK,
			},
			{
				command: ["TTL", key("atomic:lease")],
				expect: { kind: "integer-between", min: 1, max: 60 },
			},
		],
		substantiates: ["atomicCompareAndSet", "ttl"],
	},
];

const BOUNDED_PAYLOAD: readonly ConformanceCase[] = [
	{
		id: "bounded-payload.at-declared-maximum",
		area: "bounded-payload",
		profileId: "kv.key-value/v1",
		title: "A value of exactly the declared maximum size round-trips intact",
		rationale:
			"A declared limit that fails one byte early is a limit the caller cannot plan against. This case is skipped — never passed — when no limit is declared.",
		steps: [
			{
				command: ["SET", key("bounded:max"), { fill: "max-value-bytes" }],
				expect: OK,
			},
			{
				command: ["GET", key("bounded:max")],
				expect: { kind: "byte-length", of: "max-value-bytes" },
			},
		],
		substantiates: ["maxValueBytes"],
	},
	{
		id: "bounded-payload.over-declared-maximum-is-rejected",
		area: "bounded-payload",
		profileId: "kv.key-value/v1",
		title: "A value one byte over the declared maximum is rejected",
		rationale:
			"Silent truncation is worse than rejection: the write reports success and the data is already wrong. Rejection is what lets a caller fall back to a blob store.",
		steps: [
			{
				command: ["SET", key("bounded:over"), { fill: "over-max-value-bytes" }],
				expect: { kind: "error" },
			},
			{ command: ["GET", key("bounded:over")], expect: NIL },
		],
		substantiates: ["maxValueBytes"],
	},
];

const CONSISTENCY: readonly ConformanceCase[] = [
	{
		id: "consistency.read-your-writes",
		area: "consistency",
		profileId: "kv.key-value/v1",
		title:
			"A read immediately after a write on the same connection sees that write",
		rationale:
			"This is the only consistency property a single client can establish by observation, and it is therefore the only one this suite is willing to assert. See KV_REDIS_CONSISTENCY_CLAIMS for what is deliberately left unasserted.",
		steps: [
			{ command: ["SET", key("consistency:ryw"), "written"], expect: OK },
			{ command: ["GET", key("consistency:ryw")], expect: value("written") },
		],
		substantiates: ["readYourWrites"],
	},
	{
		id: "consistency.monotonic-counter-in-session",
		area: "consistency",
		profileId: "kv.redis-compatible/v1",
		title: "Sequential increments from one client never go backwards",
		rationale:
			"A read-only replica answering a write-path read shows up here as a counter that repeats or regresses. It is a weak signal, but it is a real one and it costs three commands.",
		steps: [
			{ command: ["INCR", key("consistency:seq")], expect: value(1) },
			{ command: ["INCR", key("consistency:seq")], expect: value(2) },
			{ command: ["INCR", key("consistency:seq")], expect: value(3) },
		],
		substantiates: ["readYourWrites"],
	},
];

export const KV_REDIS_CONFORMANCE_CASES: readonly ConformanceCase[] = [
	...TRANSPORT,
	...KEY_VALUE,
	...TTL,
	...ATOMICITY,
	...BOUNDED_PAYLOAD,
	...CONSISTENCY,
];

/**
 * Consistency properties, and whether this suite is willing to assert them.
 *
 * The unasserted entries are the honest part. A single client cannot observe
 * cross-replica linearizability or durability across a failover, so no case
 * here claims them, and a provider that copies this list without adding its
 * own evidence is not permitted to claim them either.
 */
// parallel-type-allowed: the authored claim makes `conformanceCaseId` present exactly when `asserted` is true, which proto3 cannot express; the proto ConsistencyClaim is its recorded wire projection.
export type ConsistencyClaim = {
	readonly key: string;
	readonly asserted: boolean;
	/** The case that establishes it, when one exists. */
	readonly conformanceCaseId?: string;
	readonly note: string;
};

export const KV_REDIS_CONSISTENCY_CLAIMS: readonly ConsistencyClaim[] = [
	{
		key: "readYourWrites",
		asserted: true,
		conformanceCaseId: "consistency.read-your-writes",
		note: "A read following a write on the same client observes that write.",
	},
	{
		key: "monotonicSequentialWrites",
		asserted: true,
		conformanceCaseId: "consistency.monotonic-counter-in-session",
		note: "Sequential server-side increments from one client are monotonic.",
	},
	{
		key: "linearizableAcrossClients",
		asserted: false,
		note: "Not asserted. Establishing it needs concurrent clients and a real-time ordering oracle, neither of which a single-client suite has.",
	},
	{
		key: "durableAcrossFailover",
		asserted: false,
		note: "Not asserted. An acknowledged write surviving a node loss can only be shown by inducing the failure, which this suite never does.",
	},
	{
		key: "crossRegionReplicationBound",
		asserted: false,
		note: "Not asserted. Replication lag is a deployment property of the specific database, not of Redis command semantics.",
	},
];
