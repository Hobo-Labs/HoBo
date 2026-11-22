import { describe, expect, it } from "vitest";
import { createRivetDistributedJournal } from "../src/distributed-actor.js";
import {
	initialDistributedJournal,
	transitionDistributedJournal,
} from "../src/distributed-journal.js";
import { testCapability } from "./test-capability.js";

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
		expect(conflict.state.grants).toEqual(first.state.grants);
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
			requestId: "request-1",
			fenceToken: 1,
			nowMs: 31_002,
		});
		expect(stale.result).toMatchObject({
			status: "denied",
			code: "STALE_LEASE",
		});
		expect(stale.state.grants).toEqual(next.state.grants);
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
			requestId: "request-1",
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
				expectedRevision: 1,
			}).result,
		).toMatchObject({ status: "denied", code: "EVENT_ID_CONFLICT" });
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
				requestId: "forged",
				eventId: "event-2",
				expectedRevision: 1,
			}).result,
		).toMatchObject({ status: "denied", code: "STALE_LEASE" });
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
				requestId: "request-1",
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
			expect(rejected.state.entries).toEqual(granted.state.entries);
		}
	});

	it("refuses a corrupt persisted epoch instead of issuing a reused fence", () => {
		const state = { ...initialDistributedJournal(), epoch: -1 };
		const result = transitionDistributedJournal(state, {
			kind: "acquire",
			holderId: "a",
			requestId: "request",
			nowMs: 1_000,
		});
		expect(result.result).toMatchObject({
			status: "denied",
			code: "CORRUPT_STATE",
		});
		expect(result.state).toBe(state);
	});

	it("never makes an observed-expired lease valid after a clock rollback", () => {
		const granted = transitionDistributedJournal(initialDistributedJournal(), {
			kind: "acquire",
			holderId: "a",
			requestId: "one",
			nowMs: 1_000,
		});
		const expired = transitionDistributedJournal(granted.state, {
			kind: "check",
			holderId: "a",
			requestId: "one",
			fenceToken: 1,
			nowMs: 31_000,
		});
		expect(expired.result).toMatchObject({
			status: "denied",
			code: "STALE_LEASE",
		});
		const rolledBack = transitionDistributedJournal(expired.state, {
			kind: "check",
			holderId: "a",
			requestId: "one",
			fenceToken: 1,
			nowMs: 2_000,
		});
		expect(rolledBack.result).toMatchObject({
			status: "denied",
			code: "CLOCK_REGRESSION",
		});
	});
});

describe("Rivet journal client boundary", () => {
	it("preserves a verified read denial", async () => {
		const journal = createRivetDistributedJournal(
			{
				getOrCreate: () => ({
					acquire: async () => ({ status: "denied" as const, code: "unused" }),
					check: async () => ({ status: "valid" as const }),
					release: async () => ({ status: "released" as const }),
					append: async () => ({ status: "denied" as const, code: "unused" }),
					read: async () => ({
						status: "denied" as const,
						code: "REVISION_CONFLICT",
					}),
				}),
			},
			{ tenantId: "tenant", campId: "camp", issueCapability: testCapability },
		);
		await expect(journal.read("orders")).rejects.toMatchObject({
			code: "REVISION_CONFLICT",
			operation: "read",
			requiresReconciliation: false,
		});
	});
	it.each([
		undefined,
		{
			status: "acquired",
			fenceToken: Number.NaN,
			expiresAtMs: 10,
			duplicate: false,
		},
		{
			get status() {
				throw new Error("unreadable");
			},
		},
	])("reports an ambiguous grant when a receipt is malformed", async (receipt) => {
		const namespace = {
			getOrCreate: () => ({
				// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: malformed receipts exercise the external Rivet boundary.
				acquire: async () => receipt as never,
				check: async () => ({ status: "valid" as const }),
				release: async () => ({ status: "released" as const }),
				append: async () => ({
					status: "appended" as const,
					revision: 1,
					duplicate: false,
				}),
				read: async () => ({ status: "ok" as const, revision: 0, events: [] }),
			}),
		};
		const journal = createRivetDistributedJournal(namespace, {
			tenantId: "tenant",
			campId: "camp",
			issueCapability: testCapability,
		});
		await expect(
			journal.acquireWithRequest("orders", {
				holderId: "writer",
				requestId: "request",
			}),
		).rejects.toMatchObject({
			code: "OUTCOME_UNKNOWN",
			requiresReconciliation: true,
			requestId: "request",
		});
	});

	it("returns an independent copy of a verified journal read", async () => {
		const source = {
			status: "ok" as const,
			revision: 1,
			nextRevision: 1,
			hasMore: false,
			events: [{ eventId: "one", event: { type: "Saved", value: "original" } }],
		};
		const namespace = {
			getOrCreate: () => ({
				acquire: async () => ({ status: "denied" as const, code: "unused" }),
				check: async () => ({ status: "valid" as const }),
				release: async () => ({ status: "released" as const }),
				append: async () => ({
					status: "appended" as const,
					revision: 1,
					duplicate: false,
				}),
				read: async () => source,
			}),
		};
		const journal = createRivetDistributedJournal(namespace, {
			tenantId: "tenant",
			campId: "camp",
			issueCapability: testCapability,
		});
		const snapshot = await journal.read("orders");
		const first = source.events[0];
		if (first === undefined) throw new Error("missing test event");
		first.event.value = "changed";
		expect(snapshot.events[0]?.event.value).toBe("original");
	});
});
