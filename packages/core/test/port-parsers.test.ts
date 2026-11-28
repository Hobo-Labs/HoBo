import { afterEach, describe, expect, it, vi } from "vitest";

import {
	ClockParseError,
	createClockReplayResult,
	createCronSchedule,
	createFiredTimer,
	createScheduledTimer,
	NondeterministicClockError,
	parseCronEveryMs,
	parseDelayMs,
	parseFireId,
	parseIsoInstant,
	parseScheduleId,
	parseTimerId,
} from "../src/ports/clock.js";
import {
	createMeteringBus,
	createUsageEvent,
	type MeteringSink,
} from "../src/ports/metering.js";
import {
	allowDecision,
	denyDecision,
	type PolicyRequest,
} from "../src/ports/policy-engine.js";
import {
	createEnqueueResult,
	createLeasedMessage,
	parseActorKey,
	parseDequeueOptions,
	parseIdempotencyKey,
	parseLeaseId,
	parseMessageId,
	parseQueueName,
	QueueLeaseLostError,
	QueueParseError,
} from "../src/ports/queue.js";
import {
	createStreamerFrame,
	createStreamerRunResult,
	DEFAULT_STREAM_NAME,
	parseRunId,
	parseSeq,
	parseStreamName,
	StreamerBackpressureError,
	StreamerClosedError,
	StreamerParseError,
} from "../src/ports/streamer.js";
import {
	LOCAL_DEFAULT_TENANT_ID,
	parseProjectId,
	parseTenantId,
	type TenantId,
	tenantContextFromEnv,
} from "../src/ports/tenant.js";

const INSTANT = "2026-08-08T00:00:00.000Z";

afterEach(() => {
	vi.useRealTimers();
});

describe("clock id and number parsers", () => {
	it("accept well-formed values", () => {
		expect(parseTimerId("t-1")).toBe("t-1");
		expect(parseScheduleId("s-1")).toBe("s-1");
		expect(parseFireId("f-1")).toBe("f-1");
		expect(parseIsoInstant(INSTANT)).toBe(INSTANT);
		expect(parseDelayMs(0)).toBe(0);
		expect(parseCronEveryMs(1)).toBe(1);
	});

	it("refuse empty ids", () => {
		for (const parse of [parseTimerId, parseScheduleId, parseFireId]) {
			expect(() => parse("")).toThrow(ClockParseError);
		}
	});

	it("allows a zero delay but not a zero cron interval", () => {
		expect(parseDelayMs(0)).toBe(0);
		expect(() => parseCronEveryMs(0)).toThrow(ClockParseError);
	});

	it("refuse negative, fractional and unsafe numbers", () => {
		for (const bad of [
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			2 ** 60,
		]) {
			expect(() => parseDelayMs(bad)).toThrow(ClockParseError);
			expect(() => parseCronEveryMs(bad)).toThrow(ClockParseError);
		}
	});

	it("refuse a malformed instant", () => {
		for (const bad of ["", "not-a-date", "2026-13-45T00:00:00Z"]) {
			expect(() => parseIsoInstant(bad)).toThrow(ClockParseError);
		}
	});

	it("tag every refusal with the clock parse code", () => {
		try {
			parseTimerId("");
			expect.unreachable("empty timer id must be refused");
		} catch (error) {
			// SAFETY: parseTimerId("") above establishes the caught error type.
			expect((error as ClockParseError).code).toBe("HOBO_CORE_CLOCK_PARSE");
			// SAFETY: parseTimerId("") above establishes the caught error type.
			expect((error as ClockParseError).name).toBe("ClockParseError");
		}
	});
});

describe("createScheduledTimer", () => {
	const RECORD = {
		timer_id: "t-1",
		run_id: "run-1",
		idempotency_key: "k-1",
		fire_at: INSTANT,
		deduped: false,
	};

	it("maps the wire record to the domain shape", () => {
		const timer = createScheduledTimer(RECORD);
		expect(timer.timerId).toBe("t-1");
		expect(timer.runId).toBe("run-1");
		expect(timer.idempotencyKey).toBe("k-1");
		expect(timer.fireAt).toBe(INSTANT);
	});

	it("carries the deduped flag through in both states", () => {
		expect(createScheduledTimer(RECORD).deduped).toBe(false);
		expect(createScheduledTimer({ ...RECORD, deduped: true }).deduped).toBe(
			true,
		);
	});

	it("freezes the result", () => {
		expect(Object.isFrozen(createScheduledTimer(RECORD))).toBe(true);
	});

	it("refuses each malformed field", () => {
		expect(() => createScheduledTimer({ ...RECORD, timer_id: "" })).toThrow();
		expect(() => createScheduledTimer({ ...RECORD, run_id: "" })).toThrow();
		expect(() =>
			createScheduledTimer({ ...RECORD, idempotency_key: "" }),
		).toThrow();
		expect(() =>
			createScheduledTimer({ ...RECORD, fire_at: "soon" }),
		).toThrow();
	});

	it("refuses a run id that is only whitespace", () => {
		expect(() => createScheduledTimer({ ...RECORD, run_id: "   " })).toThrow(
			StreamerParseError,
		);
	});
});

describe("createCronSchedule", () => {
	const RECORD = {
		schedule_id: "s-1",
		every_ms: 60_000,
		next_fire_at: INSTANT,
		deduped: false,
	};

	it("maps the wire record", () => {
		const schedule = createCronSchedule(RECORD);
		expect(schedule.scheduleId).toBe("s-1");
		expect(schedule.everyMs).toBe(60_000);
		expect(schedule.nextFireAt).toBe(INSTANT);
		expect(Object.isFrozen(schedule)).toBe(true);
	});

	it("refuses a non-positive interval", () => {
		expect(() => createCronSchedule({ ...RECORD, every_ms: 0 })).toThrow();
		expect(() => createCronSchedule({ ...RECORD, every_ms: -1 })).toThrow();
	});
});

describe("createFiredTimer", () => {
	const RECORD = {
		fire_id: "f-1",
		kind: "sleep" as const,
		at: INSTANT,
		order: 0,
	};

	it("builds the minimal sleep firing", () => {
		const fired = createFiredTimer(RECORD);
		expect(fired.fireId).toBe("f-1");
		expect(fired.kind).toBe("sleep");
		expect(fired.order).toBe(0);
	});

	it("omits every optional field that was absent", () => {
		const fired = createFiredTimer(RECORD);
		expect(Object.hasOwn(fired, "timerId")).toBe(false);
		expect(Object.hasOwn(fired, "runId")).toBe(false);
		expect(Object.hasOwn(fired, "label")).toBe(false);
		expect(Object.hasOwn(fired, "scheduleId")).toBe(false);
		expect(Object.hasOwn(fired, "occurrence")).toBe(false);
	});

	it("carries a fully-populated cron firing", () => {
		const fired = createFiredTimer({
			...RECORD,
			kind: "cron",
			schedule_id: "s-1",
			occurrence: 3,
			label: "nightly",
			timer_id: "t-1",
			run_id: "run-1",
		});
		expect(fired.scheduleId).toBe("s-1");
		expect(fired.occurrence).toBe(3);
		expect(fired.label).toBe("nightly");
		expect(fired.timerId).toBe("t-1");
		expect(fired.runId).toBe("run-1");
	});

	it("accepts occurrence zero", () => {
		const fired = createFiredTimer({ ...RECORD, occurrence: 0 });
		expect(fired.occurrence).toBe(0);
	});

	it("accepts an empty label without refusing it", () => {
		expect(createFiredTimer({ ...RECORD, label: "" }).label).toBe("");
	});

	it("refuses a negative order and a negative occurrence", () => {
		expect(() => createFiredTimer({ ...RECORD, order: -1 })).toThrow();
		expect(() => createFiredTimer({ ...RECORD, occurrence: -1 })).toThrow();
	});

	it("freezes the result", () => {
		expect(Object.isFrozen(createFiredTimer(RECORD))).toBe(true);
	});
});

describe("createClockReplayResult", () => {
	it("parses every fire id in the order", () => {
		const result = createClockReplayResult({
			seed: "seed-1",
			fire_order: ["f-1", "f-2"],
			final_now: INSTANT,
		});
		expect(result.seed).toBe("seed-1");
		expect(result.fireOrder).toEqual(["f-1", "f-2"]);
		expect(result.finalNow).toBe(INSTANT);
	});

	it("accepts an empty fire order", () => {
		expect(
			createClockReplayResult({
				seed: "s",
				fire_order: [],
				final_now: INSTANT,
			}).fireOrder,
		).toEqual([]);
	});

	it("refuses an empty seed and an empty fire id", () => {
		expect(() =>
			createClockReplayResult({
				seed: "",
				fire_order: [],
				final_now: INSTANT,
			}),
		).toThrow(ClockParseError);
		expect(() =>
			createClockReplayResult({
				seed: "s",
				fire_order: ["f-1", ""],
				final_now: INSTANT,
			}),
		).toThrow(ClockParseError);
	});
});

describe("NondeterministicClockError", () => {
	it("carries a stable code for callers to switch on", () => {
		const error = new NondeterministicClockError("Date.now() called");
		expect(error.code).toBe("CLOCK_NONDETERMINISTIC");
		expect(error.name).toBe("NondeterministicClockError");
		expect(error.message).toBe("Date.now() called");
		expect(error).toBeInstanceOf(Error);
	});
});

describe("queue id parsers", () => {
	it("accept well-formed values", () => {
		expect(parseMessageId("m-1")).toBe("m-1");
		expect(parseQueueName("orders")).toBe("orders");
		expect(parseLeaseId("l-1")).toBe("l-1");
		expect(parseIdempotencyKey("k-1")).toBe("k-1");
		expect(parseActorKey("actor:1")).toBe("actor:1");
	});

	it("refuse empty values with the queue parse code", () => {
		for (const parse of [
			parseMessageId,
			parseQueueName,
			parseLeaseId,
			parseIdempotencyKey,
			parseActorKey,
		]) {
			try {
				parse("");
				expect.unreachable("empty must be refused");
			} catch (error) {
				// SAFETY: parse("") above establishes the caught error type.
				expect((error as QueueParseError).code).toBe("HOBO_CORE_QUEUE_PARSE");
			}
		}
	});

	it("do not trim, so whitespace-only ids are accepted", () => {
		expect(parseMessageId(" ")).toBe(" ");
	});
});

describe("parseDequeueOptions", () => {
	it("applies both defaults when called with nothing", () => {
		expect(parseDequeueOptions()).toEqual({
			maxMessages: 1,
			visibilityTimeoutMs: 30_000,
		});
	});

	it("applies each default independently", () => {
		expect(parseDequeueOptions({ maxMessages: 5 }).visibilityTimeoutMs).toBe(
			30_000,
		);
		expect(
			parseDequeueOptions({ visibilityTimeoutMs: 1_000 }).maxMessages,
		).toBe(1);
	});

	it("freezes the result", () => {
		expect(Object.isFrozen(parseDequeueOptions())).toBe(true);
	});

	it("refuses zero and negative values for both fields", () => {
		expect(() => parseDequeueOptions({ maxMessages: 0 })).toThrow(
			QueueParseError,
		);
		expect(() => parseDequeueOptions({ visibilityTimeoutMs: 0 })).toThrow(
			QueueParseError,
		);
		expect(() => parseDequeueOptions({ maxMessages: -1 })).toThrow();
	});

	it("refuses a fractional count", () => {
		expect(() => parseDequeueOptions({ maxMessages: 1.5 })).toThrow();
	});
});

describe("createEnqueueResult", () => {
	it("maps the record and freezes it", () => {
		const result = createEnqueueResult({
			message_id: "m-1",
			idempotency_key: "k-1",
			deduped: true,
		});
		expect(result.messageId).toBe("m-1");
		expect(result.idempotencyKey).toBe("k-1");
		expect(result.deduped).toBe(true);
		expect(Object.isFrozen(result)).toBe(true);
	});

	it("refuses an empty message id or idempotency key", () => {
		expect(() =>
			createEnqueueResult({
				message_id: "",
				idempotency_key: "k",
				deduped: false,
			}),
		).toThrow();
		expect(() =>
			createEnqueueResult({
				message_id: "m",
				idempotency_key: "",
				deduped: false,
			}),
		).toThrow();
	});
});

describe("createLeasedMessage", () => {
	const RECORD = {
		message_id: "m-1",
		queue_name: "orders",
		idempotency_key: "k-1",
		body: { hello: "world" },
		lease_id: "l-1",
		lease_expires_at: INSTANT,
		delivery_attempt: 0,
	};

	it("maps every field", () => {
		const message = createLeasedMessage(RECORD);
		expect(message.messageId).toBe("m-1");
		expect(message.queueName).toBe("orders");
		expect(message.leaseId).toBe("l-1");
		expect(message.leaseExpiresAt).toBe(INSTANT);
		expect(message.deliveryAttempt).toBe(0);
		expect(message.body).toEqual({ hello: "world" });
	});

	it("deep-freezes the body along with the envelope", () => {
		const message = createLeasedMessage(RECORD);
		expect(Object.isFrozen(message)).toBe(true);
		expect(Object.isFrozen(message.body)).toBe(true);
	});

	it("passes a non-object body through untouched", () => {
		expect(createLeasedMessage({ ...RECORD, body: "raw" }).body).toBe("raw");
		expect(createLeasedMessage({ ...RECORD, body: null }).body).toBeNull();
	});

	it("accepts a first delivery and a redelivery", () => {
		expect(
			createLeasedMessage({ ...RECORD, delivery_attempt: 3 }).deliveryAttempt,
		).toBe(3);
		expect(() =>
			createLeasedMessage({ ...RECORD, delivery_attempt: -1 }),
		).toThrow();
	});

	it("refuses a malformed lease expiry", () => {
		expect(() =>
			createLeasedMessage({ ...RECORD, lease_expires_at: "soon" }),
		).toThrow(QueueParseError);
	});

	it("refuses each empty identifier", () => {
		for (const key of [
			"message_id",
			"queue_name",
			"idempotency_key",
			"lease_id",
		] as const) {
			expect(() => createLeasedMessage({ ...RECORD, [key]: "" })).toThrow();
		}
	});
});

describe("QueueLeaseLostError", () => {
	it("carries a stable code", () => {
		const error = new QueueLeaseLostError("lease l-1 expired");
		expect(error.code).toBe("QUEUE_LEASE_LOST");
		expect(error.name).toBe("QueueLeaseLostError");
	});
});

describe("streamer parsers", () => {
	it("trims a run id", () => {
		expect(parseRunId("  run-1  ")).toBe("run-1");
	});

	it("refuses an empty or whitespace-only run id", () => {
		expect(() => parseRunId("")).toThrow(StreamerParseError);
		expect(() => parseRunId("   ")).toThrow(StreamerParseError);
	});

	it("refuses a non-string run id", () => {
		// SAFETY: this test deliberately bypasses the typed API to exercise its runtime boundary.
		expect(() => parseRunId(7 as never)).toThrow(StreamerParseError);
		// SAFETY: this test deliberately bypasses the typed API to exercise its runtime boundary.
		expect(() => parseRunId(null as never)).toThrow(StreamerParseError);
	});

	it("defaults the stream name", () => {
		expect(parseStreamName()).toBe(DEFAULT_STREAM_NAME);
		expect(parseStreamName("stderr")).toBe("stderr");
	});

	it("refuses an empty stream name", () => {
		expect(() => parseStreamName("")).toThrow(StreamerParseError);
	});

	it("requires a positive seq", () => {
		expect(parseSeq(1)).toBe(1);
		expect(() => parseSeq(0)).toThrow(StreamerParseError);
		expect(() => parseSeq(-1)).toThrow(StreamerParseError);
		expect(() => parseSeq(1.5)).toThrow(StreamerParseError);
	});
});

describe("createStreamerFrame", () => {
	it("keeps both the wire and the parsed run id", () => {
		const frame = createStreamerFrame(
			{ run_id: " run-1 ", seq: 1, stream: "stdout" },
			"chunk",
		);
		expect(frame.run_id).toBe(" run-1 ");
		expect(frame.runId).toBe("run-1");
		expect(frame.seq).toBe(1);
		expect(frame.stream).toBe("stdout");
		expect(frame.chunk).toBe("chunk");
		expect(Object.isFrozen(frame)).toBe(true);
	});

	it("defaults the stream when the record omits it", () => {
		const frame = createStreamerFrame(
			// SAFETY: the omitted stream field is the runtime input under test.
			{ run_id: "run-1", seq: 1 } as never,
			"c",
		);
		expect(frame.stream).toBe(DEFAULT_STREAM_NAME);
	});

	it("deep-freezes an object chunk", () => {
		const frame = createStreamerFrame(
			{ run_id: "run-1", seq: 1, stream: "stdout" },
			{ nested: { a: 1 } },
		);
		expect(Object.isFrozen(frame.chunk)).toBe(true);
	});

	it("refuses a bad seq before building anything", () => {
		expect(() =>
			createStreamerFrame({ run_id: "run-1", seq: 0, stream: "stdout" }, "c"),
		).toThrow(StreamerParseError);
	});
});

describe("createStreamerRunResult", () => {
	it("accepts each declared status", () => {
		for (const status of ["completed", "closed", "failed"] as const) {
			const result = createStreamerRunResult({
				run_id: "run-1",
				status,
				reason: "done",
			});
			expect(result.status).toBe(status);
		}
	});

	it("refuses an undeclared status and names the alternatives", () => {
		try {
			createStreamerRunResult({
				run_id: "run-1",
				// SAFETY: this test deliberately supplies an undeclared runtime status.
				status: "complete" as never,
				reason: "done",
			});
			expect.unreachable("an unknown status must be refused");
		} catch (error) {
			// SAFETY: createStreamerRunResult above establishes the caught error type.
			expect((error as StreamerParseError).expected).toBe(
				"completed | closed | failed",
			);
			// SAFETY: createStreamerRunResult above establishes the caught error type.
			expect((error as StreamerParseError).path).toBe("status");
		}
	});

	it("requires a reason", () => {
		expect(() =>
			createStreamerRunResult({
				run_id: "run-1",
				status: "completed",
				reason: "",
			}),
		).toThrow(StreamerParseError);
	});

	it("keeps the raw run id alongside the parsed one", () => {
		const result = createStreamerRunResult({
			run_id: " run-1 ",
			status: "closed",
			reason: "teardown",
		});
		expect(result.run_id).toBe(" run-1 ");
		expect(result.runId).toBe("run-1");
		expect(Object.isFrozen(result)).toBe(true);
	});
});

describe("streamer errors", () => {
	it("backpressure names the run and the limit", () => {
		// SAFETY: the constructor boundary is deliberately exercised with its wire value.
		const error = new StreamerBackpressureError("run-1" as never, 1024);
		expect(error.code).toBe("STREAMER_BACKPRESSURE");
		expect(error.runId).toBe("run-1");
		expect(error.bufferLimit).toBe(1024);
		expect(error.message).toContain("run-1");
		expect(error.message).toContain("1024");
	});

	it("closed names the run", () => {
		// SAFETY: the constructor boundary is deliberately exercised with its wire value.
		const error = new StreamerClosedError("run-1" as never);
		expect(error.code).toBe("STREAMER_CLOSED");
		expect(error.runId).toBe("run-1");
		expect(error.message).toContain("run-1");
	});
});

describe("tenant parsers", () => {
	it("trim and accept a real id", () => {
		expect(parseTenantId("  acme  ")).toBe("acme");
		expect(parseProjectId(" web ")).toBe("web");
	});

	it("refuse empty and whitespace-only ids", () => {
		for (const bad of ["", "   ", "\t\n"]) {
			expect(() => parseTenantId(bad)).toThrow(TypeError);
			expect(() => parseProjectId(bad)).toThrow(TypeError);
		}
	});

	it("report which id was empty", () => {
		expect(() => parseTenantId("")).toThrow("tenantId must be non-empty");
		expect(() => parseProjectId("")).toThrow("projectId must be non-empty");
	});

	it("exposes the local default tenant", () => {
		expect(LOCAL_DEFAULT_TENANT_ID).toBe("local");
	});
});

describe("tenantContextFromEnv", () => {
	it("falls back to the local tenant when nothing is set", () => {
		const context = tenantContextFromEnv({});
		expect(context.tenantId).toBe("local");
		expect(Object.hasOwn(context, "projectId")).toBe(false);
		expect(Object.hasOwn(context, "branch")).toBe(false);
		expect(Object.hasOwn(context, "env")).toBe(false);
	});

	it("prefers HOBO_TENANT over HOBO_MCP_TENANT", () => {
		expect(
			tenantContextFromEnv({ HOBO_TENANT: "a", HOBO_MCP_TENANT: "b" }).tenantId,
		).toBe("a");
		expect(tenantContextFromEnv({ HOBO_MCP_TENANT: "b" }).tenantId).toBe("b");
	});

	it("prefers HOBO_BRANCH over GIT_BRANCH and HOBO_ENV over NODE_ENV", () => {
		const context = tenantContextFromEnv({
			HOBO_BRANCH: "feature",
			GIT_BRANCH: "main",
			HOBO_ENV: "staging",
			NODE_ENV: "production",
		});
		expect(context.branch).toBe("feature");
		expect(context.env).toBe("staging");
	});

	it("falls back to GIT_BRANCH and NODE_ENV", () => {
		const context = tenantContextFromEnv({
			GIT_BRANCH: "main",
			NODE_ENV: "production",
		});
		expect(context.branch).toBe("main");
		expect(context.env).toBe("production");
	});

	it("treats a whitespace-only optional value as unset", () => {
		const context = tenantContextFromEnv({
			HOBO_PROJECT: "   ",
			HOBO_BRANCH: "",
			HOBO_ENV: " ",
		});
		expect(Object.hasOwn(context, "projectId")).toBe(false);
		expect(Object.hasOwn(context, "branch")).toBe(false);
		expect(Object.hasOwn(context, "env")).toBe(false);
	});

	it("parses a project id when one is set", () => {
		expect(tenantContextFromEnv({ HOBO_PROJECT: " web " }).projectId).toBe(
			"web",
		);
	});

	it("keeps a whitespace-padded branch verbatim", () => {
		expect(tenantContextFromEnv({ HOBO_BRANCH: " main " }).branch).toBe(
			" main ",
		);
	});

	it("refuses a whitespace-only explicit tenant", () => {
		expect(() => tenantContextFromEnv({ HOBO_TENANT: "  " })).toThrow(
			TypeError,
		);
	});
});

describe("createUsageEvent", () => {
	// SAFETY: this literal is the valid parsed tenant id used by the fixture.
	const TENANT = "acme" as TenantId;

	it("defaults quantity, unit and timestamp", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(INSTANT));
		const event = createUsageEvent({
			tenantId: TENANT,
			eventType: "tunnel.up",
			resource: "tunnel-1",
		});
		expect(event.quantity).toBe(1);
		expect(event.unit).toBe("count");
		expect(event.timestamp).toBe(INSTANT);
	});

	it("honours explicit quantity, unit and timestamp", () => {
		const event = createUsageEvent({
			tenantId: TENANT,
			eventType: "tunnel.heartbeat",
			resource: "tunnel-1",
			quantity: 5,
			unit: "seconds",
			timestamp: INSTANT,
		});
		expect(event.quantity).toBe(5);
		expect(event.unit).toBe("seconds");
		expect(event.timestamp).toBe(INSTANT);
	});

	it("keeps an explicit zero quantity", () => {
		expect(
			createUsageEvent({
				tenantId: TENANT,
				eventType: "policy.evaluate",
				resource: "r",
				quantity: 0,
			}).quantity,
		).toBe(0);
	});

	it("keeps an explicit empty unit", () => {
		expect(
			createUsageEvent({
				tenantId: TENANT,
				eventType: "policy.evaluate",
				resource: "r",
				unit: "",
			}).unit,
		).toBe("");
	});

	it("omits metadata when none was given", () => {
		const event = createUsageEvent({
			tenantId: TENANT,
			eventType: "dns.suggest",
			resource: "r",
		});
		expect(Object.hasOwn(event, "metadata")).toBe(false);
	});

	it("carries metadata when given", () => {
		const event = createUsageEvent({
			tenantId: TENANT,
			eventType: "dns.suggest",
			resource: "r",
			metadata: { region: "us-east-1", cached: true, attempts: 2 },
		});
		expect(event.metadata).toEqual({
			region: "us-east-1",
			cached: true,
			attempts: 2,
		});
	});
});

describe("createMeteringBus", () => {
	function recordingSink(sinkId: string) {
		const seen: string[] = [];
		const sink: MeteringSink = {
			sinkId,
			emit(event) {
				seen.push(event.resource);
			},
		};
		return { sink, seen };
	}

	const EVENT = createUsageEvent({
		// SAFETY: this literal is the valid parsed tenant id used by the fixture.
		tenantId: "acme" as TenantId,
		eventType: "overlay.join",
		resource: "node-1",
		timestamp: INSTANT,
	});

	it("starts empty by default", () => {
		expect(createMeteringBus().listSinks()).toEqual([]);
	});

	it("seeds from the initial sinks", () => {
		const a = recordingSink("a");
		expect(createMeteringBus([a.sink]).listSinks()).toEqual([a.sink]);
	});

	it("fans an event out to every sink", () => {
		const a = recordingSink("a");
		const b = recordingSink("b");
		const bus = createMeteringBus([a.sink, b.sink]);
		return bus.emit(EVENT).then(() => {
			expect(a.seen).toEqual(["node-1"]);
			expect(b.seen).toEqual(["node-1"]);
		});
	});

	it("awaits an async sink", async () => {
		let resolved = false;
		const bus = createMeteringBus([
			{
				sinkId: "slow",
				async emit() {
					await Promise.resolve();
					resolved = true;
				},
			},
		]);
		await bus.emit(EVENT);
		expect(resolved).toBe(true);
	});

	it("rejects when a sink throws", async () => {
		const bus = createMeteringBus([
			{
				sinkId: "bad",
				emit() {
					throw new Error("sink down");
				},
			},
		]);
		await expect(bus.emit(EVENT)).rejects.toThrow("sink down");
	});

	it("adds and removes sinks by id", () => {
		const a = recordingSink("a");
		const bus = createMeteringBus();
		bus.addSink(a.sink);
		expect(bus.listSinks()).toHaveLength(1);
		bus.removeSink("a");
		expect(bus.listSinks()).toEqual([]);
	});

	it("replaces a sink registered under an existing id", () => {
		const first = recordingSink("a");
		const second = recordingSink("a");
		const bus = createMeteringBus([first.sink]);
		bus.addSink(second.sink);
		expect(bus.listSinks()).toEqual([second.sink]);
	});

	it("ignores removal of an unknown id", () => {
		const bus = createMeteringBus();
		expect(() => bus.removeSink("nope")).not.toThrow();
	});

	it("returns a fresh array from listSinks", () => {
		const bus = createMeteringBus([recordingSink("a").sink]);
		// SAFETY: listSinks returns the package's typed sink collection.
		const listed = bus.listSinks() as MeteringSink[];
		listed.length = 0;
		expect(bus.listSinks()).toHaveLength(1);
	});
});

describe("policy decisions", () => {
	const REQUEST: PolicyRequest = {
		subject: {
			identity: "svc:checkout",
			// SAFETY: this literal is the valid parsed tenant id used by the fixture.
			tenantId: "acme" as TenantId,
			tags: ["role:junction"],
		},
		action: "connect",
		resource: {
			kind: "junction",
			id: "j-1",
			// SAFETY: this literal is the valid parsed tenant id used by the fixture.
			tenantId: "acme" as TenantId,
		},
	};

	it("builds a deny decision with the caller's reasons", () => {
		const decision = denyDecision("acl-v1", REQUEST, ["tag missing"]);
		expect(decision.effect).toBe("deny");
		expect(decision.engineId).toBe("acl-v1");
		expect(decision.reasons).toEqual(["tag missing"]);
	});

	it("copies the request into the audit record", () => {
		const decision = denyDecision("acl-v1", REQUEST, []);
		expect(decision.audit.tenantId).toBe("acme");
		expect(decision.audit.action).toBe("connect");
		expect(decision.audit.resourceKind).toBe("junction");
		expect(decision.audit.resourceId).toBe("j-1");
		expect(decision.audit.subjectIdentity).toBe("svc:checkout");
	});

	it("audits the subject's tenant, not the resource's", () => {
		const decision = denyDecision(
			"acl-v1",
			{
				...REQUEST,
				resource: {
					...REQUEST.resource,
					// SAFETY: this literal is the valid parsed tenant id used by the fixture.
					tenantId: "other" as TenantId,
				},
			},
			["cross-tenant"],
		);
		expect(decision.audit.tenantId).toBe("acme");
	});

	it("stamps the decision time", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(INSTANT));
		expect(denyDecision("acl-v1", REQUEST, []).audit.decidedAt).toBe(INSTANT);
	});

	it("defaults an allow decision's reasons", () => {
		expect(allowDecision("acl-v1", REQUEST).reasons).toEqual(["allowed"]);
	});

	it("omits obligations when none are given", () => {
		const decision = allowDecision("acl-v1", REQUEST, ["ok"]);
		expect(Object.hasOwn(decision, "obligations")).toBe(false);
	});

	it("carries obligations when given, including an empty list", () => {
		expect(
			allowDecision("acl-v1", REQUEST, ["ok"], ["mfa"]).obligations,
		).toEqual(["mfa"]);
		const empty = allowDecision("acl-v1", REQUEST, ["ok"], []);
		expect(Object.hasOwn(empty, "obligations")).toBe(true);
		expect(empty.obligations).toEqual([]);
	});

	it("marks the effect on both helpers", () => {
		expect(allowDecision("acl-v1", REQUEST).effect).toBe("allow");
		expect(denyDecision("acl-v1", REQUEST, []).effect).toBe("deny");
	});
});
