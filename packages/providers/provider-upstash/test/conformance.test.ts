/**
 * The offline conformance run behind `UPSTASH_CONFORMANCE_REF`.
 *
 * This is the test that makes the definition's `conformance: "pass"` mean
 * something, and it is important to be precise about what it establishes. The
 * provider-neutral suite emits real Redis commands; they travel through the
 * real `createUpstashRestExecutor`, are encoded as the real REST envelope, and
 * are answered by the reference Redis implementation from
 * `@hobo/kv-redis-compatible` rather than by Upstash.
 *
 * So it proves the **adapter** implements the profile: command mapping, REST
 * envelope, reply decoding, error mapping. It does not measure Upstash. The
 * README says so in the same words, and the conformance ref carries
 * `offline-reference-store` in its name so a catalog reader cannot mistake one
 * for the other.
 */
import assert from "node:assert/strict";
import {
	createReferenceRedisStore,
	type KvRedisExecutor,
	type RedisCommand,
	type RedisReply,
	type ReferenceStore,
	runKvRedisConformance,
	toProfileImplementations,
	toStructuredCapabilities,
} from "@hobo/kv-redis-compatible";
import { describe, it } from "vitest";

import {
	UPSTASH_CONFORMANCE_REF,
	UPSTASH_STRUCTURED_CAPABILITIES,
} from "../src/definition.js";
import { isProviderError } from "../src/errors.js";
import { isJsonArray, isJsonString, parseJsonValue } from "../src/json.js";
import {
	createUpstashRestExecutor,
	parseRestReply,
} from "../src/rest-executor.js";
import type { UpstashTransport } from "../src/transport.js";
import { FAKE_REST_TOKEN, FAKE_REST_URL } from "./fixtures/index.js";

/**
 * Decode the request body the adapter produced back into a command.
 *
 * This is the reference *server's* parse boundary, so it holds the adapter to
 * the wire contract: a JSON array of strings, nothing else. Accepting a looser
 * shape here would let an adapter bug — a number left unstringified, a nested
 * array — pass the suite because the local server happened to be forgiving in
 * a way the real one is not.
 */
function parseCommandBody(body: string | undefined): RedisCommand {
	const decoded = parseJsonValue(body ?? "null");
	assert.ok(isJsonArray(decoded), "the REST body must be a JSON array");
	assert.ok(decoded.length > 0, "a command must have a verb");
	const parts: string[] = [];
	for (const element of decoded) {
		assert.ok(isJsonString(element), "every command element must be a string");
		parts.push(element);
	}
	const [verb, ...args] = parts;
	if (verb === undefined) {
		throw new Error("a command must have a verb");
	}
	return [verb, ...args];
}

/**
 * A transport that answers the Upstash REST contract from a local store.
 *
 * Everything on the wire is real: the JSON command array, the bearer header,
 * the `{"result": …}` / `{"error": …}` envelope. Only the server is local.
 */
type ReferenceRestHarness = {
	readonly transport: UpstashTransport;
	readonly store: ReferenceStore;
	readonly authorizations: readonly string[];
};

function createReferenceRestTransport(
	options: { readonly maxValueBytes?: number } = {},
): ReferenceRestHarness {
	const store = createReferenceRedisStore(
		options.maxValueBytes !== undefined
			? { maxValueBytes: options.maxValueBytes }
			: {},
	);
	const authorizations: string[] = [];

	const transport: UpstashTransport = {
		async request(request) {
			authorizations.push(request.headers.authorization ?? "");
			const reply: RedisReply = await store.execute(
				parseCommandBody(request.body),
			);
			const envelope =
				reply.kind === "error"
					? { error: reply.message }
					: { result: reply.value };
			return {
				status: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify(envelope),
			};
		},
	};

	return { transport, store, authorizations };
}

function executorOver(transport: UpstashTransport) {
	return createUpstashRestExecutor({
		transport,
		restEndpointUrl: FAKE_REST_URL,
		resolveToken: async () => FAKE_REST_TOKEN,
	});
}

/** The reference store's declared value bound, used only by the harness. */
const REFERENCE_MAX_VALUE_BYTES = 64 * 1024;

/**
 * The full offline harness: the real adapter, plus the reference *server's*
 * clock.
 *
 * The time control belongs to the server, not to the adapter — a real Upstash
 * endpoint has a real clock, and `createUpstashRestExecutor` deliberately
 * exposes no `advanceTime` (pinned by its own test above). Wiring the
 * reference store's clock in here lets the expiry cases run against a server
 * whose clock we own, which is the whole point of a reference implementation.
 */
type OfflineHarness = {
	readonly executor: KvRedisExecutor;
	readonly authorizations: readonly string[];
};

function offlineHarness(): OfflineHarness {
	const { transport, store, authorizations } = createReferenceRestTransport({
		maxValueBytes: REFERENCE_MAX_VALUE_BYTES,
	});
	const rest = executorOver(transport);
	return {
		authorizations,
		executor: {
			execute: (command) => rest.execute(command),
			advanceTime: (ms) => store.advanceTime(ms),
		},
	};
}

describe("createUpstashRestExecutor", () => {
	it("sends a command as a JSON array with a bearer token", async () => {
		const { transport, authorizations } = createReferenceRestTransport();

		const reply = await executorOver(transport).execute([
			"SET",
			"greeting",
			"hello",
		]);

		assert.deepEqual(reply, { kind: "value", value: "OK" });
		assert.deepEqual(authorizations, [`Bearer ${FAKE_REST_TOKEN}`]);
	});

	it("resolves the token per request rather than holding it", async () => {
		const { transport } = createReferenceRestTransport();
		let resolutions = 0;
		const executor = createUpstashRestExecutor({
			transport,
			restEndpointUrl: FAKE_REST_URL,
			resolveToken: async () => {
				resolutions += 1;
				return FAKE_REST_TOKEN;
			},
		});

		await executor.execute(["SET", "a", "1"]);
		await executor.execute(["GET", "a"]);

		assert.equal(resolutions, 2);
	});

	it("returns a command-level error as a reply, not as a throw", async () => {
		const { transport } = createReferenceRestTransport();
		const executor = executorOver(transport);
		await executor.execute(["SET", "text", "notanumber"]);

		const reply = await executor.execute(["INCR", "text"]);

		// WRONGTYPE and friends are legitimate Redis replies; the suite
		// asserts on several of them.
		assert.equal(reply.kind, "error");
	});

	it("maps a rejected token to PROVIDER_AUTH_FAILED", async () => {
		const executor = executorOver({
			async request() {
				return { status: 401, headers: {}, body: "unauthorized" };
			},
		});

		await assert.rejects(
			executor.execute(["PING"]),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_AUTH_FAILED",
		);
	});

	it("maps a vanished endpoint to LEASE_EXPIRED", async () => {
		const executor = executorOver({
			async request() {
				return { status: 404, headers: {}, body: "not found" };
			},
		});

		await assert.rejects(
			executor.execute(["PING"]),
			(error: Error) =>
				isProviderError(error) && error.code === "LEASE_EXPIRED",
		);
	});

	it("exposes no time control, so expiry is never faked", () => {
		const { transport } = createReferenceRestTransport();
		// A real endpoint has a real clock. Offering `advanceTime` here would
		// let the suite "prove" TTL behavior it never observed.
		assert.equal(executorOver(transport).advanceTime, undefined);
	});
});

describe("parseRestReply", () => {
	it("decodes a nested array reply", () => {
		assert.deepEqual(
			parseRestReply(JSON.stringify({ result: ["a", 1, null, ["b"]] })),
			{
				kind: "value",
				value: ["a", 1, null, ["b"]],
			},
		);
	});

	it("refuses an envelope with neither result nor error", () => {
		assert.throws(
			() => parseRestReply(JSON.stringify({ status: "ok" })),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_CONTRACT_CHANGED",
		);
	});

	it("refuses a reply value outside the RESP value space", () => {
		assert.throws(
			() => parseRestReply(JSON.stringify({ result: { nested: "object" } })),
			(error: Error) =>
				isProviderError(error) && error.code === "PROVIDER_CONTRACT_CHANGED",
		);
	});
});

describe("offline conformance", () => {
	it("passes the Redis-compatible suite over the REST adapter", async () => {
		const report = await runKvRedisConformance({
			executor: offlineHarness().executor,
			transport: "rest",
			keyPrefix: "upstash",
			limits: { maxValueBytes: REFERENCE_MAX_VALUE_BYTES },
		});

		// `incomplete` would be the honest result if a required case could not
		// run; it maps to `unknown` conformance and fails selection closed.
		assert.equal(
			report.outcome,
			"pass",
			`failed: ${report.failedCaseIds.join(", ")}; skipped: ${report.skippedCaseIds.join(", ")}`,
		);
		assert.deepEqual(report.failedCaseIds, []);
	});

	it("degrades to incomplete when the harness has no clock, rather than claiming TTL", async () => {
		// The property worth pinning is the failure mode: without a time
		// control the expiry cases are skipped, the run is `incomplete`, and
		// `incomplete` becomes `unknown` conformance — which selection
		// rejects. A suite that reported `pass` here would be the bug.
		const { transport } = createReferenceRestTransport();

		const report = await runKvRedisConformance({
			executor: executorOver(transport),
			transport: "rest",
			keyPrefix: "upstash",
		});

		assert.equal(report.outcome, "incomplete");
		assert.ok(report.skippedCaseIds.includes("ttl.key-actually-expires"));
		assert.equal(toStructuredCapabilities(report).ttl, undefined);
		assert.ok(
			toProfileImplementations(report, { conformanceRef: "test" }).every(
				(implementation) => implementation.conformance === "unknown",
			),
		);
	});

	it("substantiates exactly the capabilities the definition advertises", async () => {
		const report = await runKvRedisConformance({
			executor: offlineHarness().executor,
			transport: "rest",
			keyPrefix: "upstash",
			limits: { maxValueBytes: REFERENCE_MAX_VALUE_BYTES },
		});
		// Deliberately projected without the limits: the bound the run proved
		// is the reference store's, and publishing it would read as a
		// measurement of Upstash.
		const capabilities = toStructuredCapabilities(report);

		for (const key of [
			"ttl",
			"atomicIncrement",
			"sortedSets",
			"restTransport",
		]) {
			assert.equal(
				capabilities[key],
				true,
				`${key} should be substantiated by the run`,
			);
			assert.equal(
				UPSTASH_STRUCTURED_CAPABILITIES[key],
				true,
				`${key} is advertised, so the run must substantiate it`,
			);
		}
		// Not advertised, because the reference store's bound is the reference
		// store's, not Upstash's.
		assert.equal(capabilities.maxValueBytes, undefined);
		assert.equal(UPSTASH_STRUCTURED_CAPABILITIES.maxValueBytes, undefined);
	});

	it("declares the kv profiles and nothing else", async () => {
		const report = await runKvRedisConformance({
			executor: offlineHarness().executor,
			transport: "rest",
			keyPrefix: "upstash",
			limits: { maxValueBytes: REFERENCE_MAX_VALUE_BYTES },
		});
		const implementations = toProfileImplementations(report, {
			conformanceRef: UPSTASH_CONFORMANCE_REF,
		});

		assert.deepEqual(
			implementations.map((implementation) => implementation.profileId).sort(),
			["kv.key-value/v1", "kv.redis-compatible/v1"],
		);
		assert.ok(
			implementations.every(
				(implementation) => implementation.conformance === "pass",
			),
		);
	});

	it("names the reference store in the conformance ref, not a live database", () => {
		// The claim is "this adapter implements the profile", not "Upstash was
		// measured". A catalog reader has to be able to tell.
		assert.match(UPSTASH_CONFORMANCE_REF, /offline-reference-store/u);
	});
});
