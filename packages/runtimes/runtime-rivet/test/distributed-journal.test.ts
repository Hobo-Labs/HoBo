import { describe, expect, it } from "vitest";
import {
	initialDistributedJournal,
	transitionDistributedJournal,
} from "../src/distributed-journal.js";

describe("Rivet distributed journal state machine", () => {
	it("grants a monotonically fenced lease and rejects another live holder", () => {
		const initial = initialDistributedJournal();
		const first = transitionDistributedJournal(initial, {
			kind: "acquire",
			holderId: "a",
			requestId: "request-1",
			nowMs: 1_000,
		});
		expect(first.result).toMatchObject({ status: "acquired", fenceToken: 1 });
		const conflict = transitionDistributedJournal(first.state, {
			kind: "acquire",
			holderId: "b",
			requestId: "request-2",
			nowMs: 1_001,
		});
		expect(conflict.result).toMatchObject({
			status: "denied",
			code: "LEASE_HELD",
		});
		expect(conflict.state).toBe(first.state);
		const next = transitionDistributedJournal(first.state, {
			kind: "acquire",
			holderId: "b",
			requestId: "request-2",
			nowMs: 31_001,
		});
		expect(next.result).toMatchObject({ status: "acquired", fenceToken: 2 });
		const stale = transitionDistributedJournal(next.state, {
			kind: "release",
			holderId: "a",
			fenceToken: 1,
			nowMs: 31_002,
		});
		expect(stale.result).toMatchObject({
			status: "denied",
			code: "STALE_LEASE",
		});
		expect(stale.state).toBe(next.state);
	});

	it("replays the same lease request without renewing its expiry", () => {
		const input = {
			kind: "acquire",
			holderId: "a",
			requestId: "request-1",
			nowMs: 1_000,
		} as const;
		const first = transitionDistributedJournal(
			initialDistributedJournal(),
			input,
		);
		const replay = transitionDistributedJournal(first.state, {
			...input,
			nowMs: 2_000,
		});
		expect(replay.result).toMatchObject({
			status: "acquired",
			fenceToken: 1,
			duplicate: true,
			expiresAtMs: 31_000,
		});
		const expired = transitionDistributedJournal(first.state, {
			...input,
			nowMs: 31_000,
		});
		expect(expired.result).toMatchObject({
			status: "denied",
			code: "LEASE_EXPIRED",
		});
	});

	it("appends only under the active fence and expected revision, and deduplicates event ids", () => {
		const granted = transitionDistributedJournal(initialDistributedJournal(), {
			kind: "acquire",
			holderId: "a",
			requestId: "request-1",
			nowMs: 1_000,
		});
		const append = {
			kind: "append",
			holderId: "a",
			fenceToken: 1,
			expectedRevision: 0,
			eventId: "event-1",
			event: { type: "OrderCreated", amount: 2 },
			nowMs: 1_001,
		} as const;
		const first = transitionDistributedJournal(granted.state, append);
		expect(first.result).toMatchObject({
			status: "appended",
			revision: 1,
			duplicate: false,
		});
		expect(
			transitionDistributedJournal(first.state, append).result,
		).toMatchObject({
			status: "appended",
			revision: 1,
			duplicate: true,
		});
		expect(
			transitionDistributedJournal(first.state, {
				...append,
				event: { type: "Other" },
			}).result,
		).toMatchObject({
			status: "denied",
			code: "EVENT_ID_CONFLICT",
		});
		expect(
			transitionDistributedJournal(first.state, {
				...append,
				eventId: "event-2",
			}).result,
		).toMatchObject({
			status: "denied",
			code: "REVISION_CONFLICT",
		});
		expect(
			transitionDistributedJournal(first.state, {
				...append,
				eventId: "event-2",
				expectedRevision: 1,
				nowMs: 31_000,
			}).result,
		).toMatchObject({
			status: "denied",
			code: "STALE_LEASE",
		});
	});

	it("rejects malformed and oversized event data without changing state", () => {
		const granted = transitionDistributedJournal(initialDistributedJournal(), {
			kind: "acquire",
			holderId: "a",
			requestId: "request-1",
			nowMs: 1_000,
		});
		for (const event of [
			{ type: "" },
			{ type: "Big", payload: "x".repeat(65_537) },
			{ type: "Bad", amount: Number.NaN },
		]) {
			const rejected = transitionDistributedJournal(granted.state, {
				kind: "append",
				holderId: "a",
				fenceToken: 1,
				expectedRevision: 0,
				eventId: "event",
				event,
				nowMs: 1_001,
			});
			expect(rejected.result).toMatchObject({
				status: "denied",
				code: "INVALID_EVENT",
			});
			expect(rejected.state).toBe(granted.state);
		}
	});
});
