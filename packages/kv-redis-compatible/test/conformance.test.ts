import { describe, expect, it } from "vitest";

import {
	CONFORMANCE_AREAS,
	createReferenceRedisStore,
	createTimelessReferenceStore,
	KV_REDIS_CONFORMANCE_CASES,
	KV_REDIS_CONSISTENCY_CLAIMS,
	KvRedisCompatibleError,
	runKvRedisConformance,
	toProfileImplementations,
	toStructuredCapabilities,
} from "../src/index.js";

const MAX_VALUE_BYTES = 4096;

async function runAgainstReferenceStore(
	options: { readonly breakVerb?: string } = {},
) {
	return runKvRedisConformance({
		executor: createReferenceRedisStore({
			maxValueBytes: MAX_VALUE_BYTES,
			...(options.breakVerb !== undefined
				? { breakVerb: options.breakVerb }
				: undefined),
		}),
		transport: "in-process",
		limits: { maxValueBytes: MAX_VALUE_BYTES },
	});
}

describe("the case catalog", () => {
	it("has unique ids and a rationale on every case", () => {
		const ids = KV_REDIS_CONFORMANCE_CASES.map((entry) => entry.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const entry of KV_REDIS_CONFORMANCE_CASES) {
			expect(entry.rationale.length).toBeGreaterThan(40);
			expect(entry.steps.length).toBeGreaterThan(0);
		}
	});

	it("covers every declared conformance area", () => {
		const covered = new Set(
			KV_REDIS_CONFORMANCE_CASES.map((entry) => entry.area),
		);
		expect([...covered].sort()).toEqual([...CONFORMANCE_AREAS].sort());
	});

	it("never cites a queue or topic profile as the subject of a case", () => {
		for (const entry of KV_REDIS_CONFORMANCE_CASES) {
			expect(entry.profileId.startsWith("kv.")).toBe(true);
		}
	});
});

describe("running the suite against a conformant store", () => {
	it("passes every case and substantiates exactly the proven capabilities", async () => {
		const report = await runAgainstReferenceStore();
		expect(report.failedCaseIds).toEqual([]);
		expect(report.skippedCaseIds).toEqual([]);
		expect(report.outcome).toBe("pass");
		expect(report.substantiatedCapabilities).toEqual([
			"atomicCompareAndSet",
			"atomicIncrement",
			"maxValueBytes",
			"readYourWrites",
			"redisCommandSemantics",
			"sortedSets",
			"ttl",
		]);
	});

	it("reports restTransport only when the run actually used a REST transport", async () => {
		const inProcess = await runAgainstReferenceStore();
		expect(inProcess.substantiatedCapabilities).not.toContain("restTransport");

		const rest = await runKvRedisConformance({
			executor: createReferenceRedisStore({ maxValueBytes: MAX_VALUE_BYTES }),
			transport: "rest",
			limits: { maxValueBytes: MAX_VALUE_BYTES },
		});
		expect(rest.substantiatedCapabilities).toContain("restTransport");
	});

	it("projects a pass into declarable profile implementations", async () => {
		const report = await runAgainstReferenceStore();
		const implementations = toProfileImplementations(report, {
			conformanceRef: "conformance.kv.redis-compatible/v1#reference",
		});
		expect(implementations.map((entry) => entry.profileId)).toEqual([
			"kv.key-value/v1",
			"kv.redis-compatible/v1",
		]);
		expect(implementations.every((entry) => entry.conformance === "pass")).toBe(
			true,
		);
	});

	it("emits maxValueBytes as the declared number, not as a flag", async () => {
		const report = await runAgainstReferenceStore();
		expect(
			toStructuredCapabilities(report, {
				limits: { maxValueBytes: MAX_VALUE_BYTES },
			}),
		).toEqual({
			atomicCompareAndSet: true,
			atomicIncrement: true,
			maxValueBytes: MAX_VALUE_BYTES,
			readYourWrites: true,
			redisCommandSemantics: true,
			sortedSets: true,
			ttl: true,
		});
	});
});

describe("running the suite against a store that falls short", () => {
	it("fails the run and names the case when an atomic operation is broken", async () => {
		const report = await runAgainstReferenceStore({ breakVerb: "INCR" });
		expect(report.outcome).toBe("fail");
		expect(report.failedCaseIds).toContain("atomicity.incr-counter");
		expect(report.substantiatedCapabilities).not.toContain("atomicIncrement");
	});

	it("still withholds a capability when only some of its cases pass", async () => {
		// SET ... NX EX passes, SET ... NX alone does not; one out of two is
		// not evidence for a create-if-absent guarantee.
		const report = await runAgainstReferenceStore({ breakVerb: "GET" });
		expect(report.substantiatedCapabilities).not.toContain(
			"atomicCompareAndSet",
		);
	});

	it("maps a failed run to a failed conformance claim", async () => {
		const report = await runAgainstReferenceStore({ breakVerb: "INCR" });
		const implementations = toProfileImplementations(report, {
			conformanceRef: "ref",
		});
		expect(implementations.every((entry) => entry.conformance === "fail")).toBe(
			true,
		);
	});
});

describe("what the runner refuses to assume", () => {
	it("skips expiry observation rather than passing it when time cannot be controlled", async () => {
		const report = await runKvRedisConformance({
			executor: createTimelessReferenceStore({
				maxValueBytes: MAX_VALUE_BYTES,
			}),
			transport: "in-process",
			limits: { maxValueBytes: MAX_VALUE_BYTES },
		});
		expect(report.skippedCaseIds).toEqual(["ttl.key-actually-expires"]);
		expect(report.outcome).toBe("incomplete");
	});

	it("skips the bounded-payload cases rather than inventing a limit", async () => {
		const report = await runKvRedisConformance({
			executor: createReferenceRedisStore(),
			transport: "in-process",
		});
		expect(report.skippedCaseIds).toEqual([
			"bounded-payload.at-declared-maximum",
			"bounded-payload.over-declared-maximum-is-rejected",
		]);
		expect(report.substantiatedCapabilities).not.toContain("maxValueBytes");
	});

	it("turns an incomplete run into unknown conformance, which selection fails closed on", async () => {
		const report = await runKvRedisConformance({
			executor: createReferenceRedisStore(),
			transport: "in-process",
		});
		expect(report.outcome).toBe("incomplete");
		expect(
			toProfileImplementations(report, { conformanceRef: "ref" }).every(
				(entry) => entry.conformance === "unknown",
			),
		).toBe(true);
	});

	it("treats a thrown executor as a harness failure, never as an expected error reply", async () => {
		await expect(
			runKvRedisConformance({
				executor: {
					async execute() {
						throw new Error("socket closed");
					},
				},
				transport: "rest",
			}),
		).rejects.toThrow(KvRedisCompatibleError);
	});

	it("refuses a key prefix that could address arbitrary keys", async () => {
		await expect(
			runKvRedisConformance({
				executor: createReferenceRedisStore(),
				transport: "in-process",
				keyPrefix: "*",
			}),
		).rejects.toThrow(/key prefix/u);
	});

	it("namespaces conformance keys so a live run cannot collide with application data", async () => {
		const executor = createReferenceRedisStore({
			maxValueBytes: MAX_VALUE_BYTES,
		});
		await runKvRedisConformance({
			executor,
			transport: "in-process",
			limits: { maxValueBytes: MAX_VALUE_BYTES },
			keyPrefix: "run-42:",
		});
		const keys = executor.commands
			.flatMap((command) => command.slice(1))
			.filter((argument) => argument.includes("hobo:conf:"));
		expect(keys.length).toBeGreaterThan(0);
		expect(
			keys.every((argument) => argument.startsWith("run-42:hobo:conf:")),
		).toBe(true);
	});
});

describe("consistency claims", () => {
	it("only asserts what a single-client suite can observe", () => {
		const asserted = KV_REDIS_CONSISTENCY_CLAIMS.filter(
			(claim) => claim.asserted,
		);
		expect(asserted.map((claim) => claim.key)).toEqual([
			"readYourWrites",
			"monotonicSequentialWrites",
		]);
		for (const claim of asserted) {
			expect(
				KV_REDIS_CONFORMANCE_CASES.some(
					(entry) => entry.id === claim.conformanceCaseId,
				),
			).toBe(true);
		}
	});

	it("records the unasserted properties instead of quietly omitting them", () => {
		const unasserted = KV_REDIS_CONSISTENCY_CLAIMS.filter(
			(claim) => !claim.asserted,
		);
		expect(unasserted.map((claim) => claim.key)).toEqual([
			"linearizableAcrossClients",
			"durableAcrossFailover",
			"crossRegionReplicationBound",
		]);
		for (const claim of unasserted) {
			expect(claim.conformanceCaseId).toBeUndefined();
			expect(claim.note).toMatch(/not asserted/iu);
		}
	});
});
