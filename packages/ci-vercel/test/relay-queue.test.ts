import { create, type JsonValue } from "@bufbuild/protobuf";
import { JobSchema, LeaseSchema } from "@hobo/ci";
import { describe, expect, it } from "vitest";
import { createQueueHandoffHandler } from "../src/queue-forwarding.js";
import {
	createLeaseStepScheduler,
	encodeRelayQueueMessage,
	LEASE_STEP_LADDER_MINUTES,
	leaseStepKind,
	MAX_DELIVERY_BODY_BYTES,
	nextLeaseStepRung,
	parseRelayQueueMessage,
	RELAY_QUEUE_TOPICS,
	type RelayQueueMessage,
	RelayQueueMessageError,
} from "../src/relay-queue.js";

const LEASE = "8a0b8b8e-3f0c-5d7e-9a51-1c2d3e4f5a6b";
const job = () =>
	create(JobSchema, {
		id: 4001,
		runId: 900,
		runAttempt: 1,
		repositoryId: 101,
		installationId: 10,
		repository: "Org/Repo",
		isolatedRequired: true,
		action: "queued",
	});

describe("the stateless relay's queue messages", () => {
	it("round-trips a delivery and a lease step through their protobuf JSON", () => {
		const delivery: RelayQueueMessage = {
			kind: "delivery",
			delivery: {
				deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
				event: "workflow_job",
				installationId: 10,
				repositoryId: 101,
				rawBody: new TextEncoder().encode('{"action":"queued"}'),
				receivedAt: "2026-11-11T12:00:00.000Z",
			},
		};
		const wire = encodeRelayQueueMessage(delivery);
		expect(wire).toMatchObject({
			kind: "delivery",
			deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
			rawBody: Buffer.from('{"action":"queued"}').toString("base64"),
		});
		expect(parseRelayQueueMessage(JSON.parse(JSON.stringify(wire)))).toEqual(
			delivery,
		);
		const step: RelayQueueMessage = {
			kind: "lease-step",
			step: { leaseId: LEASE, step: "reconcile", n: 0, job: job() },
		};
		const stepWire = encodeRelayQueueMessage(step);
		// Implicit fields are on the wire: rung 0 is not left out.
		expect(stepWire).toMatchObject({ kind: "lease-step", n: 0 });
		expect(parseRelayQueueMessage(stepWire)).toEqual(step);
	});

	it("still parses the repair tick and a pre-4b wakeup, and nothing else", () => {
		expect(
			parseRelayQueueMessage({
				source: "static",
				name: "hobo-ci-repair",
				scheduleId: "sched_1",
			}),
		).toEqual({ kind: "repair", source: "static", platformSchedule: true });
		expect(parseRelayQueueMessage({ deliveryId: "d-1" })).toEqual({
			kind: "wakeup",
			deliveryId: "d-1",
		});
		expect(parseRelayQueueMessage(null)).toEqual({ kind: "manual" });
		for (const bad of [
			{ deliveryId: "d-1", source: "static", name: "hobo-ci-repair" },
			{ kind: "lease-step", leaseId: LEASE, step: "scan", n: 0 },
			{
				kind: "delivery",
				deliveryId: "d-1",
				event: "push",
				installationId: 1,
				repositoryId: 1,
				rawBody: "e30=",
				receivedAt: "2026-11-11T12:00:00Z",
			},
			{ source: "cron", name: "hobo-ci-repair" },
		])
			expect(() => parseRelayQueueMessage(bad)).toThrow(RelayQueueMessageError);
	});
});

describe("lease steps", () => {
	it("maps each in-flight state to the one chain that watches it", () => {
		expect(
			Object.fromEntries(
				[
					"reserved",
					"dispatching",
					"dispatched",
					"claiming",
					"running",
					"uncertain",
					"completed",
					"cancelled",
				].map((state) => [state, leaseStepKind(state)]),
			),
		).toEqual({
			reserved: "dispatch-check",
			dispatching: "dispatch-check",
			dispatched: "claim-timeout",
			claiming: "claim-timeout",
			running: "reconcile",
			uncertain: "reconcile",
			completed: undefined,
			cancelled: undefined,
		});
	});

	it("puts every rung at a fixed time after the lease's creation, so chains of one lease collapse", () => {
		const createdAt = "2026-11-11T12:00:00.000Z";
		const t0 = Date.parse(createdAt);
		expect(nextLeaseStepRung(createdAt, t0)).toEqual({
			n: 0,
			dueMs: t0 + 60_000,
		});
		// Started late, a chain joins the ladder at the next rung due.
		expect(nextLeaseStepRung(createdAt, t0 + 4 * 60_000)).toEqual({
			n: 2,
			dueMs: t0 + 5 * 60_000,
		});
		expect(
			nextLeaseStepRung(
				createdAt,
				t0 + (LEASE_STEP_LADDER_MINUTES.at(-1) ?? 0) * 60_000,
			),
		).toBeUndefined();
	});

	it("starts a chain when a lease enters it, and only then", async () => {
		const sent: { topic: string; key: string | undefined; delay: number }[] =
			[];
		let now = Date.parse("2026-11-11T12:00:30.000Z");
		const scheduler = createLeaseStepScheduler({
			send: async (topic, _payload, options) => {
				sent.push({
					topic,
					key: options.idempotencyKey,
					delay: options.delaySeconds ?? 0,
				});
			},
			now: () => now,
		});
		const lease = create(LeaseSchema, {
			id: LEASE,
			state: "reserved",
			createdAt: "2026-11-11T12:00:00.000Z",
			jobId: 4001,
			originalRunId: 900,
			runAttempt: 1,
			repositoryId: 101,
			installationId: 10,
			repository: "Org/Repo",
		});
		await scheduler.changed({ lease, previousState: undefined });
		await scheduler.changed({
			lease: { ...lease, state: "dispatching" },
			previousState: "reserved",
		});
		now += 60_000;
		await scheduler.changed({
			lease: { ...lease, state: "running" },
			previousState: "claiming",
		});
		await scheduler.changed({
			lease: { ...lease, state: "uncertain" },
			previousState: "running",
		});
		await scheduler.changed({
			lease: { ...lease, state: "completed" },
			previousState: "running",
		});
		expect(sent).toEqual([
			{
				topic: RELAY_QUEUE_TOPICS.steps,
				key: `${LEASE}:dispatch-check:0`,
				delay: 30,
			},
			{
				topic: RELAY_QUEUE_TOPICS.steps,
				key: `${LEASE}:reconcile:1`,
				delay: 60,
			},
		]);
		expect(
			await scheduler.next({ ...lease, state: "running" }, "reconcile", 1),
		).toBe(true);
		expect(sent.at(-1)?.key).toBe(`${LEASE}:reconcile:2`);
	});
});

describe("the queue handoff carries the stateless relay's messages", () => {
	const origin = "https://ci.example.test";
	const secret = "s".repeat(40);
	const post = (body: JsonValue) =>
		new Request(`${origin}/internal/queue-wakeup`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${secret}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
	const handler = (run: (message: RelayQueueMessage) => Promise<void>) =>
		createQueueHandoffHandler<RelayQueueMessage>({
			origin,
			secret,
			run,
			codec: {
				parse: parseRelayQueueMessage,
				isRepairTick: (message) => message.kind === "repair",
				maxBodyBytes: Math.ceil((MAX_DELIVERY_BODY_BYTES * 4) / 3) + 4096,
			},
		});

	it("holds a delivery or a lease step that failed, and drops a failed repair tick", async () => {
		const failing = handler(async () => {
			throw new Error("GitHub unavailable");
		});
		const delivery = encodeRelayQueueMessage({
			kind: "delivery",
			delivery: {
				deliveryId: "d-1",
				event: "workflow_job",
				installationId: 10,
				repositoryId: 101,
				rawBody: new Uint8Array(512 * 1024).fill(32),
				receivedAt: "2026-11-11T12:00:00.000Z",
			},
		});
		expect((await failing(post(delivery))).status).toBe(503);
		const step = encodeRelayQueueMessage({
			kind: "lease-step",
			step: { leaseId: LEASE, step: "reconcile", n: 3, job: job() },
		});
		expect((await failing(post(step))).status).toBe(503);
		expect(
			(await failing(post({ source: "static", name: "hobo-ci-repair" })))
				.status,
		).toBe(204);
		const seen: string[] = [];
		const working = handler(async (message) => {
			seen.push(message.kind);
		});
		expect((await working(post(delivery))).status).toBe(204);
		expect((await working(post({ kind: "lease-step" }))).status).toBe(400);
		expect(seen).toEqual(["delivery"]);
	});
});
