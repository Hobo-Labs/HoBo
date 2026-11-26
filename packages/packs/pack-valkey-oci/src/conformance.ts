/**
 * Conformance cases for `kv.redis-compatible/v1` and `kv.valkey/v1`.
 *
 * Every case is `container-runtime`: `valkey-cli` lives inside the pinned image,
 * so running any of these is running the image. The mandatory lane replays
 * recorded outcomes; the container lane is opt-in.
 *
 * Two cases are here specifically to keep the pack honest rather than to prove it
 * works: `refuses-unauthenticated-command` (a cache reachable without a password
 * is a remote shell waiting for a CONFIG SET) and `durability-matches-declared-mode`
 * (the restart case only *passes* in a mode that claims to survive one, which is
 * why the suite takes the mode as an input).
 */
import type { PackConformanceCase } from "@hobo/pack-framework";

import { VALKEY_SERVER_VERSION } from "./image.js";
import { VALKEY_DURABILITY, type ValkeyDurabilityMode } from "./semantics.js";

/** `-a` is absent on purpose: the CLI reads REDISCLI_AUTH from the environment. */
const CLI = ["valkey-cli", "--no-auth-warning"];

const BASE_CASES: readonly PackConformanceCase[] = [
	{
		id: "server-version-matches-manifest",
		profileRef: "kv.valkey/v1",
		description:
			"The pinned image reports the server version the manifest advertises, so `serverVersion` in the catalog is a fact about the bytes rather than a label.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: ["valkey-server", "--version"],
				expectExitCode: 0,
				expectStdoutContains: VALKEY_SERVER_VERSION,
			},
		],
	},
	{
		id: "answers-commands-on-the-declared-port",
		profileRef: "kv.redis-compatible/v1",
		description:
			"The declared port speaks the Redis serialization protocol and the server answers a command, which an open socket alone does not prove.",
		requires: "container-runtime",
		steps: [
			{ kind: "tcp-connect", portName: "valkey", expectReachable: true },
			{
				kind: "exec",
				argv: [...CLI, "PING"],
				expectExitCode: 0,
				expectStdoutContains: "PONG",
			},
		],
	},
	{
		id: "refuses-unauthenticated-command",
		profileRef: "kv.redis-compatible/v1",
		description:
			"A command with no credential is refused with NOAUTH, so the requirepass include is enforced rather than merely present.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				// A deliberately empty auth environment is the runner's job; the
				// expectation is the error, not the exit status, because the CLI
				// exits 0 while printing the server's error.
				argv: [...CLI, "GET", "hobo:conformance:probe"],
				expectExitCode: 0,
				expectStdoutContains: "NOAUTH",
			},
		],
	},
	{
		id: "supports-per-key-expiry",
		profileRef: "kv.key-value/v1",
		description:
			"SET with an expiry yields a positive TTL, which is the `ttl` feature claim.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: [...CLI, "SET", "hobo:conformance:ttl", "v", "EX", "60"],
				expectExitCode: 0,
				expectStdoutContains: "OK",
			},
			{
				kind: "exec",
				argv: [...CLI, "TTL", "hobo:conformance:ttl"],
				expectExitCode: 0,
				expectStdoutContains: "6",
			},
		],
	},
	{
		id: "supports-atomic-increment",
		profileRef: "kv.redis-compatible/v1",
		description:
			"INCR returns the incremented value, which is the `atomicIncrement` claim.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: [...CLI, "SET", "hobo:conformance:n", "1"],
				expectExitCode: 0,
			},
			{
				kind: "exec",
				argv: [...CLI, "INCR", "hobo:conformance:n"],
				expectExitCode: 0,
				expectStdoutContains: "2",
			},
		],
	},
	{
		id: "supports-sorted-sets",
		profileRef: "kv.redis-compatible/v1",
		description: "ZADD/ZSCORE round-trip, which is the `sortedSets` claim.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: [...CLI, "ZADD", "hobo:conformance:z", "1", "a"],
				expectExitCode: 0,
			},
			{
				kind: "exec",
				argv: [...CLI, "ZSCORE", "hobo:conformance:z", "a"],
				expectExitCode: 0,
				expectStdoutContains: "1",
			},
		],
	},
	{
		id: "applies-the-configured-eviction-policy",
		profileRef: "kv.redis-compatible/v1",
		description:
			"The running server reports the maxmemory-policy the deployment configured, so the eviction semantics advertised in the catalog describe this server and not the image default.",
		requires: "container-runtime",
		steps: [
			{
				kind: "exec",
				argv: [...CLI, "CONFIG", "GET", "maxmemory-policy"],
				expectExitCode: 0,
				expectStdoutContains: "maxmemory-policy",
			},
		],
	},
];

/**
 * The restart case, which only exists for modes that claim to survive one.
 *
 * A `none`-mode deployment genuinely does not survive a restart, so asserting that
 * it does would be a failing test for correct behaviour — and asserting nothing
 * would leave the durability claim unevidenced. Taking the mode as an input is how
 * the suite stays a description of *this* deployment.
 */
export function valkeyConformanceCases(
	durabilityMode: ValkeyDurabilityMode,
): readonly PackConformanceCase[] {
	const semantics = VALKEY_DURABILITY[durabilityMode];
	if (!semantics.survivesRestart) {
		return [
			...BASE_CASES,
			{
				id: "cache-mode-starts-empty-after-restart",
				profileRef: "kv.redis-compatible/v1",
				description:
					"In cache mode a restart starts from an empty keyspace. Asserted rather than omitted, so the documented loss is observed behaviour and not a disclaimer.",
				requires: "container-runtime",
				steps: [
					{
						kind: "exec",
						argv: [...CLI, "SET", "hobo:conformance:durable", "42"],
						expectExitCode: 0,
					},
					{
						kind: "restart-workload",
						reason: "prove the declared loss actually happens",
					},
					{
						kind: "exec",
						argv: [...CLI, "EXISTS", "hobo:conformance:durable"],
						expectExitCode: 0,
						expectStdoutContains: "0",
					},
				],
			},
		];
	}
	return [
		...BASE_CASES,
		{
			id: "survives-restart",
			profileRef: "kv.redis-compatible/v1",
			description: `A written key is still present after the workload restarts, which is what ${durabilityMode} claims (worst case ${String(semantics.worstCaseLossMs)}ms of writes lost).`,
			requires: "container-runtime",
			steps: [
				{
					kind: "exec",
					argv: [...CLI, "SET", "hobo:conformance:durable", "42"],
					expectExitCode: 0,
				},
				// In snapshot mode an unforced restart may legitimately lose the
				// key, so the case forces a save first: the claim under test is
				// "the volume holds the keyspace", not "the schedule already ran".
				...(durabilityMode === "rdb-snapshots"
					? ([
							{ kind: "exec", argv: [...CLI, "SAVE"], expectExitCode: 0 },
						] as const)
					: []),
				{
					kind: "restart-workload",
					reason: "prove the volume, not the page cache",
				},
				{
					kind: "exec",
					argv: [...CLI, "GET", "hobo:conformance:durable"],
					expectExitCode: 0,
					expectStdoutContains: "42",
				},
			],
		},
	];
}
