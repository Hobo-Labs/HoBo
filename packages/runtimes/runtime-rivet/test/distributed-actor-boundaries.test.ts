import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createRivetDistributedJournal,
	createRivetDistributedJournalActor,
} from "../src/distributed-actor.js";
import { testCapability } from "./test-capability.js";

afterEach(() => vi.restoreAllMocks());

const testActor = createRivetDistributedJournalActor(async () =>
	testCapability(),
);
const testKey = ["hobo", "tenant", "camp", "orders"];
const envelope = <T>(args: T) => ({ args, capability: testCapability() });

describe("Rivet actor action boundaries", () => {
	it.each([
		"append",
		"check",
	] as const)("checks lease expiry after queued %s begins", async (kind) => {
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		let completeTransaction: (() => void) | undefined;
		const blocked = new Promise<void>((resolve) => {
			completeTransaction = resolve;
		});
		const execute = vi.fn(async (sql: string) =>
			sql.startsWith("SELECT epoch")
				? [
						{
							epoch: 1,
							revision: 0,
							holder: "a",
							request: "one",
							expires: 31_000,
							lastNow: 1_000,
						},
					]
				: [],
		);
		const context = {
			key: testKey,
			db: {
				transaction: async (
					work: (tx: { execute: typeof execute }) => Promise<object>,
				) => {
					await blocked;
					return work({ execute });
				},
			},
		};
		const actions = testActor.config.actions;
		now = 1_001;
		const queued =
			kind === "check"
				? actions.check(
						context,
						envelope({
							holderId: "a",
							requestId: "one",
							fenceToken: 1,
						}),
					)
				: actions.append(
						context,
						envelope({
							holderId: "a",
							requestId: "one",
							fenceToken: 1,
							expectedRevision: 0,
							eventId: "e",
							event: { type: "Saved" },
						}),
					);
		now = 31_000;
		if (completeTransaction === undefined)
			throw new Error("missing blocked transaction");
		completeTransaction();
		expect(await queued).toMatchObject({
			status: "denied",
			code: "STALE_LEASE",
		});
		expect(execute.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
			false,
		);
	});

	it("does not let RPC input override the selected action", async () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const execute = vi.fn(async (sql: string) =>
			sql.startsWith("SELECT epoch")
				? [
						{
							epoch: 1,
							revision: 0,
							holder: "a",
							request: "one",
							expires: 31_000,
							lastNow: 1_000,
						},
					]
				: sql.startsWith("SELECT holder")
					? [{ holder: "a", token: 1, expires: 31_000 }]
					: [],
		);
		const context = {
			key: testKey,
			db: {
				transaction: async (
					work: (tx: { execute: typeof execute }) => Promise<object>,
				) => work({ execute }),
			},
		};
		const actions = testActor.config.actions;
		const attempted = await actions.acquire(
			context,
			envelope({
				kind: "append",
				holderId: "a",
				requestId: "one",
				fenceToken: 1,
				expectedRevision: 0,
				eventId: "e",
				event: { type: "Saved" },
			}),
		);
		expect(attempted).toMatchObject({ status: "acquired", duplicate: true });
		expect(execute.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(
			false,
		);
	});

	it("snapshots lease identity before an RPC and cannot be overridden by append input", async () => {
		let complete:
			| ((value: {
					status: "acquired";
					fenceToken: number;
					expiresAtMs: number;
					duplicate: false;
			  }) => void)
			| undefined;
		const acquireResult = new Promise<{
			status: "acquired";
			fenceToken: number;
			expiresAtMs: number;
			duplicate: false;
		}>((resolve) => {
			complete = resolve;
		});
		let received:
			| {
					holderId: string;
					requestId: string;
					fenceToken: number;
					event: { type: string; value?: string };
			  }
			| undefined;
		const namespace = {
			getOrCreate: () => ({
				acquire: async () => acquireResult,
				check: async () => ({ status: "valid" as const }),
				release: async () => ({ status: "released" as const }),
				append: async ({
					args: input,
				}: {
					args: {
						holderId: string;
						requestId: string;
						fenceToken: number;
						event: { type: string; value?: string };
					};
				}) => {
					received = input;
					return { status: "appended" as const, revision: 1, duplicate: false };
				},
				read: async () => ({ status: "ok" as const, revision: 0, events: [] }),
			}),
		};
		const journal = createRivetDistributedJournal(namespace, {
			tenantId: "tenant",
			campId: "camp",
			issueCapability: testCapability,
		});
		const request = { holderId: "original", requestId: "request" };
		const pending = journal.acquireWithRequest("orders", request);
		request.holderId = "changed";
		request.requestId = "changed";
		if (complete === undefined) throw new Error("missing grant resolver");
		complete({
			status: "acquired",
			fenceToken: 1,
			expiresAtMs: 31_000,
			duplicate: false,
		});
		const lease = await pending;
		expect(lease.holderId).toBe("original");
		const input = {
			eventId: "event",
			expectedRevision: 0,
			event: { type: "Saved", value: "original" },
			holderId: "forged",
			requestId: "forged",
			fenceToken: 99,
		};
		await journal.append("orders", lease, input);
		input.event.value = "changed";
		expect(received).toMatchObject({
			holderId: "original",
			requestId: "request",
			fenceToken: 1,
			event: { value: "original" },
		});
	});
});
