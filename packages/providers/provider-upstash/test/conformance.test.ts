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

function executorOver(
	transport: UpstashTransport,
	wait?: (ms: number) => Promise<void>,
) {
	return createUpstashRestExecutor({
		transport,
		restEndpointUrl: FAKE_REST_URL,
		resolveToken: async () => FAKE_REST_TOKEN,
		wait,
	});
}

const REFERENCE_MAX_VALUE_BYTES = 64 * 1024;

type OfflineHarness = {
	readonly executor: KvRedisExecutor;
	readonly authorizations: readonly string[];
};

function offlineHarness(): OfflineHarness {
	const { transport, store, authorizations } = createReferenceRestTransport({
		maxValueBytes: REFERENCE_MAX_VALUE_BYTES,
	});
	const rest = executorOver(transport, (ms) => store.advanceTime(ms));
	return {
		authorizations,
		executor: rest,
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

	it("advances time through its wait boundary", async () => {
		const { transport } = createReferenceRestTransport();
		const waits: number[] = [];
		const executor = executorOver(transport, async (ms) => {
			waits.push(ms);
		});
		await executor.advanceTime?.(250);
		assert.deepEqual(waits, [250]);
	});

	it("waits the full duration when it exceeds a timer's maximum delay", async () => {
		const { transport } = createReferenceRestTransport();
		const waits: number[] = [];
		const executor = executorOver(transport, async (ms) => {
			waits.push(ms);
		});
		await executor.advanceTime?.(2_147_483_772);
		assert.deepEqual(waits, [2_147_483_647, 125]);
	});

	it("rejects invalid time advancement", async () => {
		const { transport } = createReferenceRestTransport();
		for (const duration of [
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.MAX_SAFE_INTEGER + 1,
		]) {
			await assert.rejects(
				executorOver(transport).advanceTime?.(duration),
				(error: Error) =>
					isProviderError(error) && error.code === "PROVIDER_CONTRACT_CHANGED",
			);
		}
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

		assert.equal(
			report.outcome,
			"pass",
			`failed: ${report.failedCaseIds.join(", ")}; skipped: ${report.skippedCaseIds.join(", ")}`,
		);
		assert.deepEqual(report.failedCaseIds, []);
	});

	it("degrades to incomplete when the harness has no clock, rather than claiming TTL", async () => {
		const { transport } = createReferenceRestTransport();

		const rest = executorOver(transport);
		const report = await runKvRedisConformance({
			executor: { execute: (command) => rest.execute(command) },
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
		assert.match(UPSTASH_CONFORMANCE_REF, /offline-reference-store/u);
	});
});
