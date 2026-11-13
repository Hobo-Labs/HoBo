/**
 * The dispatcher and executor loops on the memory bus (design §6.9, §9 F4):
 * 400 offers across executors with 1, 2 and 5 slots each run once, in that
 * proportion; the largest dying costs one step; several dispatchers offer each
 * unit once and another takes over one step later; receipts survive a bus
 * outage and a restart; an executor with the bus down claims nothing; and the
 * executor's refusals, failures, cancellation, drain and `sandboxOf`.
 */
import { create, fromBinary } from "@bufbuild/protobuf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ClaimSchema,
	ReceiptStatus,
	Role,
	SandboxTier,
	type SignedEnvelope,
	SignedEnvelopeSchema,
	WorkOfferSchema,
	WorkOrderSchema,
	type WorkReceipt,
	WorkReceiptSchema,
} from "../../src/_generated/fleet_pb.js";
import { rankMembers } from "../../src/observation/index.js";
import type { AuthorityBus, FleetBus, SandboxDriver } from "../../src/ports.js";
import { createMemoryBus } from "../../src/testing/plumbing/index.js";
import {
	createDispatcher,
	createExecutor,
	createOciCommandRunner,
	createOciCommandSource,
	workDigest,
} from "../../src/work/index.js";
import {
	type AuthorityKey,
	authorityKey,
	type Device,
	device,
	FLEET,
	fleetRecord,
	NOW,
	offer,
	openPolicy,
	orderFor,
	publishObservation,
	seedBus,
	submission,
} from "./fixtures.js";
import {
	capacity,
	egress,
	fakeDriver,
	recorder,
	reports,
	switchableBus,
	testRunner,
	testSource,
	upstream,
} from "./harness.js";

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
	vi.useRealTimers();
});

const now = () => Date.now();

function receiptsOn(bus: FleetBus) {
	const seen: WorkReceipt[] = [];
	bus.events.subscribe(["receipt"], "start", async (event) => {
		seen.push(fromBinary(WorkReceiptSchema, event.payload));
	});
	return seen;
}

function claimsOn(bus: FleetBus) {
	const seen: { member: string; claimedAtMs: number; workDigest: string }[] =
		[];
	bus.claims.subscribe([FLEET], "start", async (claim) => {
		const decoded = fromBinary(ClaimSchema, claim.payload);
		seen.push({
			member: decoded.memberId,
			claimedAtMs: Date.parse(decoded.claimedAt),
			workDigest: decoded.workDigest,
		});
	});
	return seen;
}

type ExecutorSpec = Readonly<{
	member: Device;
	slots: number;
	runner?: ReturnType<typeof testRunner>;
	drivers?: readonly SandboxDriver[] | undefined;
	bus?: FleetBus;
}>;

async function world(
	count: number,
	options: Readonly<{ slots?: readonly number[]; dispatchers?: number }> = {},
) {
	const authority: AuthorityKey = authorityKey();
	const bus: AuthorityBus = createMemoryBus(now);
	const dispatchers = await Promise.all(
		Array.from({ length: options.dispatchers ?? 1 }, () =>
			device({ roles: [Role.DISPATCHER] }),
		),
	);
	const members = await Promise.all(
		Array.from({ length: count }, () => device({ roles: [Role.EXECUTOR] })),
	);
	await seedBus(
		bus,
		authority,
		[...dispatchers, ...members].map((member) => member.record),
		[fleetRecord(openPolicy())],
	);
	const logs = recorder();
	const observe = async (slots: readonly number[]) => {
		for (const [index, member] of members.entries())
			await publishObservation(bus, member, now(), {
				capacity: { freeSlots: slots[index] ?? 1 },
			});
	};
	const executor = (spec: ExecutorSpec) =>
		createExecutor({
			self: spec.member.keys,
			state: spec.member.store,
			bus: spec.bus ?? bus,
			runners: [spec.runner ?? testRunner()],
			sandboxes: spec.drivers ?? [fakeDriver(SandboxTier.S1_CONTAINER)],
			egress: egress(),
			capacity: capacity(spec.slots),
			now,
			log: logs.log,
		});
	return { authority, bus, dispatchers, members, logs, observe, executor };
}

describe("many executors", () => {
	it("400 offers across executors with 1, 2 and 5 slots each run once, in that proportion", async () => {
		const slots = [1, 2, 5];
		const w = await world(3, { slots });
		const runners = slots.map(() => testRunner());
		const executors = w.members.map((member, index) =>
			w.executor({
				member,
				slots: slots[index] ?? 1,
				runner: runners[index] ?? testRunner(),
			}),
		);
		await w.observe(slots);
		for (const executor of executors) executor.start();
		await vi.advanceTimersByTimeAsync(10);
		const source = testSource();
		const dispatcher = createDispatcher({
			self: w.dispatchers[0]?.keys ?? (await device()).keys,
			bus: w.bus,
			sources: [source],
			report: reports().report,
			now,
			log: () => undefined,
		});
		dispatcher.start();
		const total = 400;
		for (let index = 0; index < total; index += 1) {
			source.queue.push(upstream(`job-${index}`, now()));
			await vi.advanceTimersByTimeAsync(10_000);
			if (index % 3 === 0) await w.observe(slots);
		}
		await vi.advanceTimersByTimeAsync(120_000);
		const ran = runners.map((runner) => runner.ran.map((run) => run.workKey));
		const all = ran.flat();
		expect(all).toHaveLength(total);
		expect(new Set(all).size).toBe(total);
		const [one, two, five] = ran.map((list) => list.length);
		// Expected 50, 100 and 250; a binomial spread of about 3.5 standard deviations.
		expect(one).toBeGreaterThan(25);
		expect(one).toBeLessThan(80);
		expect(two).toBeGreaterThan(65);
		expect(two).toBeLessThan(140);
		expect(five).toBeGreaterThan(205);
		expect(five).toBeLessThan(290);
		expect(five ?? 0).toBeGreaterThan(two ?? 0);
		expect(two ?? 0).toBeGreaterThan(one ?? 0);
		await dispatcher.stop();
		for (const executor of executors) await executor.stop();
	}, 120_000);

	it("the largest dying costs one step", async () => {
		const slots = [1, 2, 5];
		const w = await world(3, { slots });
		const runners = slots.map(() => testRunner());
		const executors = w.members.map((member, index) =>
			w.executor({
				member,
				slots: slots[index] ?? 1,
				runner: runners[index] ?? testRunner(),
			}),
		);
		// The five-slot executor is gone, but its last observation still stands on the board.
		await w.observe(slots);
		executors[0]?.start();
		executors[1]?.start();
		await vi.advanceTimersByTimeAsync(10);
		const claims = claimsOn(w.bus);
		const source = testSource();
		const dispatcher = createDispatcher({
			self: w.dispatchers[0]?.keys ?? (await device()).keys,
			bus: w.bus,
			sources: [source],
			report: reports().report,
			now,
			log: () => undefined,
		});
		dispatcher.start();
		const queued = new Map<string, number>();
		const total = 40;
		for (let index = 0; index < total; index += 1) {
			const key = `job-${index}`;
			queued.set(workDigest("github-actions-job", key), now());
			source.queue.push(upstream(key, now()));
			await vi.advanceTimersByTimeAsync(10_000);
			await w.observe(slots);
		}
		await vi.advanceTimersByTimeAsync(120_000);
		expect(runners[2]?.ran).toHaveLength(0);
		const ran = [...(runners[0]?.ran ?? []), ...(runners[1]?.ran ?? [])];
		expect(ran).toHaveLength(total);
		const delays = claims.map(
			(claim) => claim.claimedAtMs - (queued.get(claim.workDigest) ?? 0),
		);
		expect(delays).toHaveLength(total);
		// Work the dead executor was first for waits one step of 20 s; none waits two.
		expect(Math.max(...delays)).toBeGreaterThanOrEqual(20_000);
		expect(Math.max(...delays)).toBeLessThan(40_000);
		expect(delays.filter((delay) => delay < 20_000).length).toBeGreaterThan(0);
		await dispatcher.stop();
		for (const executor of executors) await executor.stop();
	}, 60_000);
});

describe("several dispatchers", () => {
	it("offer each unit once; the next takes over one step later when the first is gone", async () => {
		const w = await world(1, { dispatchers: 2 });
		const offers: string[] = [];
		w.bus.offers.subscribe([FLEET], "start", async (envelope) => {
			offers.push(fromBinary(WorkOfferSchema, envelope.payload).dispatcher);
		});
		const make = (
			member: Device | undefined,
			source: ReturnType<typeof testSource>,
		) => {
			if (member === undefined) throw new Error("no dispatcher");
			return createDispatcher({
				self: member.keys,
				bus: w.bus,
				sources: [source],
				report: reports().report,
				now,
				log: () => undefined,
			});
		};
		const sources = [testSource(), testSource()];
		for (const source of sources) source.queue.push(upstream("job-1", NOW));
		const both = w.dispatchers.map((member, index) =>
			make(member, sources[index] ?? testSource()),
		);
		for (const dispatcher of both) dispatcher.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(offers).toHaveLength(1);
		for (const dispatcher of both) await dispatcher.stop();

		// Only the second-ranked dispatcher runs: it offers at its turn, one step later.
		const digest = workDigest("github-actions-job", "job-2");
		const ranked = rankMembers(
			digest,
			w.dispatchers.map((member) => ({
				memberId: member.keys.memberId,
				copies: 1,
				reliability: 1,
			})),
		);
		const second = w.dispatchers.find(
			(member) => member.keys.memberId === ranked[1],
		);
		const source = testSource();
		source.queue.push(upstream("job-2", now()));
		const offeredAt: number[] = [];
		w.bus.offers.subscribe([FLEET], "new", async () => {
			offeredAt.push(now());
		});
		const queuedAt = now();
		const alone = make(second, source);
		alone.start();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(offeredAt).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(20_000);
		expect(offeredAt).toHaveLength(1);
		expect((offeredAt[0] ?? 0) - queuedAt).toBeGreaterThanOrEqual(20_000);
		await alone.stop();
	});

	it("offers nothing the fleet's policy does not allow, and nothing while the bus is down", async () => {
		const w = await world(1);
		const logs = recorder();
		const source = testSource();
		source.queue.push(upstream("job-1", NOW, { repository: "evil/app" }));
		const bus = switchableBus(w.bus);
		const offers: SignedEnvelope[] = [];
		w.bus.offers.subscribe([FLEET], "start", async (envelope) => {
			offers.push(envelope);
		});
		const dispatcher = createDispatcher({
			self: w.dispatchers[0]?.keys ?? (await device()).keys,
			bus,
			sources: [source],
			report: reports().report,
			now,
			log: logs.log,
		});
		dispatcher.start();
		await vi.advanceTimersByTimeAsync(1_000);
		expect(offers).toHaveLength(0);
		expect(
			logs.lines.some((line) => line.fields.reason === "policy-repository"),
		).toBe(true);
		bus.down(true);
		source.queue.push(upstream("job-2", now()));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(offers).toHaveLength(0);
		expect(
			logs.lines.some((line) => line.event === "hobo_fleet_bus_status"),
		).toBe(true);
		bus.down(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(offers).toHaveLength(1);
		await dispatcher.stop();
	});
});

describe("the executor", () => {
	async function single(
		spec: Partial<ExecutorSpec> & Readonly<{ wanted?: boolean }> = {},
	) {
		const w = await world(1);
		const member = w.members[0];
		if (member === undefined) throw new Error("no member");
		const runner = spec.runner ?? testRunner();
		const bus = switchableBus(w.bus);
		const executor = w.executor({
			member,
			slots: 1,
			runner,
			bus,
			drivers: spec.drivers,
		});
		const receipts = receiptsOn(w.bus);
		const source = testSource();
		if (spec.wanted === false) source.setWanted(false);
		const dispatcher = createDispatcher({
			self: w.dispatchers[0]?.keys ?? member.keys,
			bus: w.bus,
			sources: [source],
			report: reports().report,
			now,
			log: () => undefined,
		});
		executor.start();
		await vi.advanceTimersByTimeAsync(10);
		dispatcher.start();
		return {
			...w,
			member,
			runner,
			bus,
			executor,
			receipts,
			source,
			dispatcher,
		};
	}

	it("runs an order: the secret opens, the egress proxy and sandbox are per order, logs and receipts are signed", async () => {
		const s = await single();
		const logs: SignedEnvelope[] = [];
		s.bus.events.subscribe(["log"], "start", async (event) => {
			logs.push(event);
		});
		s.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(s.runner.ran).toEqual([
			{
				workKey: "job-1",
				secret: "secret-job-1",
				tier: SandboxTier.S1_CONTAINER,
			},
		]);
		expect(s.receipts.map((receipt) => receipt.status)).toEqual([
			ReceiptStatus.STARTED,
			ReceiptStatus.SUCCEEDED,
		]);
		expect(s.receipts[1]?.observedWorkKey).toBe("");
		expect(logs.length).toBe(2);
		expect((await s.member.store.readState()).pendingReceipts).toHaveLength(0);
		expect((await s.member.store.readState()).seenOrderIds).toHaveLength(1);
		await s.dispatcher.stop();
		await s.executor.stop();
	});

	it("queues receipts while the bus is down and publishes them on reconnect and after a restart (F4)", async () => {
		let s: Awaited<ReturnType<typeof single>> | undefined;
		const runner = testRunner("github-actions-job", async () => {
			s?.bus.down(true);
			return {
				status: ReceiptStatus.SUCCEEDED,
				reason: "",
				outputDigest: "",
				observedWorkKey: "job-1",
			};
		});
		s = await single({ runner });
		s.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(s.receipts.map((receipt) => receipt.status)).toEqual([
			ReceiptStatus.STARTED,
		]);
		expect((await s.member.store.readState()).pendingReceipts).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(s.receipts).toHaveLength(1);
		await s.executor.stop();
		await s.dispatcher.stop();
		// A restarted executor on the same state publishes what was queued.
		s.bus.down(false);
		const again = createExecutor({
			self: s.member.keys,
			state: s.member.store,
			bus: s.bus,
			runners: [testRunner()],
			sandboxes: [fakeDriver(SandboxTier.S1_CONTAINER)],
			egress: egress(),
			capacity: capacity(1),
			now,
			log: () => undefined,
		});
		again.start();
		await vi.advanceTimersByTimeAsync(100);
		expect(s.receipts.map((receipt) => receipt.status)).toEqual([
			ReceiptStatus.STARTED,
			ReceiptStatus.SUCCEEDED,
		]);
		expect((await s.member.store.readState()).pendingReceipts).toHaveLength(0);
		await again.stop();
	});

	it("publishes queued receipts on reconnect without a restart", async () => {
		let s: Awaited<ReturnType<typeof single>> | undefined;
		const runner = testRunner("github-actions-job", async () => {
			s?.bus.down(true);
			return {
				status: ReceiptStatus.FAILED,
				reason: "",
				outputDigest: "",
				observedWorkKey: "other-job",
			};
		});
		s = await single({ runner });
		s.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(s.receipts).toHaveLength(1);
		s.bus.down(false);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(s.receipts.map((receipt) => receipt.status)).toEqual([
			ReceiptStatus.STARTED,
			ReceiptStatus.FAILED,
		]);
		expect(s.receipts[1]?.observedWorkKey).toBe("other-job");
		await s.dispatcher.stop();
		await s.executor.stop();
	});

	it("claims nothing while the bus is down", async () => {
		const s = await single();
		s.bus.down(true);
		s.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(s.runner.ran).toHaveLength(0);
		expect(
			s.logs.lines.some(
				(line) => line.event === "hobo_fleet_claims_unreachable",
			),
		).toBe(true);
		await s.dispatcher.stop();
		await s.executor.stop();
	});

	it("gives up a claim whose order never comes, after 30 seconds", async () => {
		const s = await single({ wanted: false });
		s.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(31_000);
		expect(s.runner.ran).toHaveLength(0);
		expect(
			s.logs.lines.some((line) => line.event === "hobo_fleet_work_claimed"),
		).toBe(true);
		await s.executor.drain();
		await s.dispatcher.stop();
		await s.executor.stop();
	});

	it("answers an attributable order it may not run with REFUSED, and a forged one with nothing", async () => {
		const s = await single();
		const dispatcher = s.dispatchers[0];
		if (dispatcher === undefined) throw new Error("no dispatcher");
		await vi.advanceTimersByTimeAsync(10);
		// No claim is held for this work.
		const unclaimed = await orderFor(
			dispatcher.keys,
			s.member,
			offer(dispatcher.keys.memberId),
		);
		await s.bus.orders.deliver(unclaimed, s.member.keys.memberId);
		await vi.advanceTimersByTimeAsync(100);
		expect(
			s.receipts.map((receipt) => [receipt.status, receipt.reason]),
		).toEqual([[ReceiptStatus.REFUSED, "order-invalid"]]);
		// The same order again is a replay and gets nothing more.
		await s.bus.orders.deliver(unclaimed, s.member.keys.memberId);
		const bytes = unclaimed.signature.slice();
		bytes[0] = (bytes[0] ?? 0) ^ 1;
		await s.bus.orders.deliver(
			create(SignedEnvelopeSchema, { ...unclaimed, signature: bytes }),
			s.member.keys.memberId,
		);
		await vi.advanceTimersByTimeAsync(100);
		expect(s.receipts).toHaveLength(1);
		await s.dispatcher.stop();
		await s.executor.stop();
	});

	it("abandons work whose sandbox cannot start, or whose runner throws", async () => {
		const broken: SandboxDriver = {
			tier: SandboxTier.S1_CONTAINER,
			available: async () => ({ ok: true, value: { providesDocker: false } }),
			create: async () => {
				throw new Error("no runtime");
			},
		};
		const s = await single({ drivers: [broken] });
		s.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(
			s.receipts.map((receipt) => [receipt.status, receipt.reason]),
		).toEqual([[ReceiptStatus.ABANDONED, "unavailable"]]);
		await s.dispatcher.stop();
		await s.executor.stop();

		const throwing = await single({
			runner: testRunner("github-actions-job", async () => {
				throw new Error("runner crashed");
			}),
		});
		throwing.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(2_000);
		expect(
			throwing.receipts.map((receipt) => [receipt.status, receipt.reason]),
		).toEqual([
			[ReceiptStatus.STARTED, ""],
			[ReceiptStatus.ABANDONED, "unavailable"],
		]);
		await throwing.dispatcher.stop();
		await throwing.executor.stop();
	});

	it("does not advertise a driver whose self-test fails, so work needing it is not claimed", async () => {
		const failing: SandboxDriver = {
			tier: SandboxTier.S1_CONTAINER,
			available: async () => ({
				ok: false,
				error: { code: "unavailable", message: "no runtime" },
			}),
			create: async () => {
				throw new Error("unused");
			},
		};
		const s = await single({ drivers: [failing] });
		s.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(s.runner.ran).toHaveLength(0);
		expect(
			s.logs.lines.some(
				(line) => line.event === "hobo_fleet_sandbox_unavailable",
			),
		).toBe(true);
		expect(s.logs.lines.some((line) => line.fields.reason === "sandbox")).toBe(
			true,
		);
		await s.dispatcher.stop();
		await s.executor.stop();
	});

	it("exposes the live sandbox, drains running work, and cancels it on stop", async () => {
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const s = await single({
			runner: testRunner("github-actions-job", async (input) => {
				await Promise.race([
					gate,
					new Promise<void>((resolve) =>
						input.signal.addEventListener("abort", () => resolve()),
					),
				]);
				return {
					status: input.signal.aborted
						? ReceiptStatus.CANCELLED
						: ReceiptStatus.SUCCEEDED,
					reason: "",
					outputDigest: "",
					observedWorkKey: "job-1",
				};
			}),
		});
		s.source.queue.push(upstream("job-1", NOW), upstream("job-2", NOW));
		await vi.advanceTimersByTimeAsync(2_000);
		const started = s.receipts.find(
			(receipt) => receipt.status === ReceiptStatus.STARTED,
		);
		expect(started).toBeDefined();
		expect(s.executor.sandboxOf(started?.orderId ?? "")?.tier).toBe(
			SandboxTier.S1_CONTAINER,
		);
		expect(s.executor.sandboxOf("f".repeat(32))).toBeUndefined();
		const draining = s.executor.drain();
		release();
		await vi.advanceTimersByTimeAsync(2_000);
		await draining;
		expect(
			s.receipts.filter(
				(receipt) => receipt.status === ReceiptStatus.SUCCEEDED,
			),
		).toHaveLength(1);
		expect(s.executor.sandboxOf(started?.orderId ?? "")).toBeUndefined();
		await s.dispatcher.stop();
		await s.executor.stop();

		const hanging = await single({
			runner: testRunner("github-actions-job", async (input) => {
				await new Promise<void>((resolve) =>
					input.signal.addEventListener("abort", () => resolve()),
				);
				return {
					status: ReceiptStatus.CANCELLED,
					reason: "",
					outputDigest: "",
					observedWorkKey: "",
				};
			}),
		});
		hanging.source.queue.push(upstream("job-1", NOW));
		await vi.advanceTimersByTimeAsync(2_000);
		await hanging.executor.stop();
		await hanging.dispatcher.stop();
		await vi.advanceTimersByTimeAsync(10);
		expect(hanging.receipts.map((receipt) => receipt.status)).toEqual([
			ReceiptStatus.STARTED,
			ReceiptStatus.CANCELLED,
		]);
	});
});

describe("the oci-command work kind", () => {
	it("offers an authority-signed submission and runs its command in the sandbox", async () => {
		const w = await world(1);
		const member = w.members[0];
		const dispatcherMember = w.dispatchers[0];
		if (member === undefined || dispatcherMember === undefined)
			throw new Error("no members");
		const driver = fakeDriver(SandboxTier.S1_CONTAINER);
		const proxies = egress();
		const executor = createExecutor({
			self: member.keys,
			state: member.store,
			bus: w.bus,
			runners: [createOciCommandRunner()],
			sandboxes: [driver],
			egress: proxies,
			capacity: capacity(1),
			now,
			log: () => undefined,
		});
		const receipts = receiptsOn(w.bus);
		executor.start();
		await vi.advanceTimersByTimeAsync(10);
		// The submitter is the device's owner: OWN work runs in S1.
		await w.bus.submissions.publish(
			await submission(w.authority, {
				submissionId: "sub-1",
				author: "github:1",
			}),
			FLEET,
		);
		// One the authority did not sign is never offered.
		await w.bus.submissions.publish(
			await submission(authorityKey(), { submissionId: "sub-2" }),
			FLEET,
		);
		const source = createOciCommandSource(w.bus);
		const dispatcher = createDispatcher({
			self: dispatcherMember.keys,
			bus: w.bus,
			sources: [source],
			report: reports().report,
			now,
			log: () => undefined,
		});
		dispatcher.start();
		await vi.advanceTimersByTimeAsync(12_000);
		expect(driver.runs).toEqual(["echo hello"]);
		expect(proxies.opened).toEqual([["example.com"]]);
		expect(receipts.map((receipt) => receipt.status)).toEqual([
			ReceiptStatus.STARTED,
			ReceiptStatus.SUCCEEDED,
		]);
		expect(receipts[1]?.outputDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
		// Once ordered it is not offered again.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(driver.runs).toHaveLength(1);
		await dispatcher.stop();
		await executor.stop();
	});

	it("the runner refuses an order without a command and reports a failing exit", async () => {
		const runner = createOciCommandRunner();
		const sandbox = await fakeDriver(SandboxTier.S1_CONTAINER).create({
			orderId: "a".repeat(32),
			image: "alpine",
			limits: { memoryMb: 1, cpus: 1, pids: 1, diskMb: 1 },
			egressProxyUrl: "",
			readOnlyMounts: [],
			hostDocker: false,
			fence: async () => true,
		});
		const dispatcher = await device({ roles: [Role.DISPATCHER] });
		const member = await device();
		const order = (parameters: Record<string, string>) =>
			orderFor(dispatcher.keys, member, offer(dispatcher.keys.memberId), {
				parameters,
			}).then((envelope) => fromBinary(WorkOrderSchema, envelope.payload));
		const run = async (
			parameters: Record<string, string>,
			signal = new AbortController().signal,
		) =>
			runner.run({
				order: await order(parameters),
				secret: new Uint8Array(),
				sandbox,
				signal,
				onLog: () => undefined,
				log: () => undefined,
			});
		expect((await run({ argv: "not json" })).status).toBe(
			ReceiptStatus.REFUSED,
		);
		expect((await run({ argv: JSON.stringify([1, 2]) })).status).toBe(
			ReceiptStatus.REFUSED,
		);
		expect((await run({ argv: "[]" })).status).toBe(ReceiptStatus.REFUSED);
		expect(
			(
				await run({
					argv: JSON.stringify(["true"]),
					env: JSON.stringify({ A: "1", B: 2 }),
				})
			).status,
		).toBe(ReceiptStatus.SUCCEEDED);
		expect(
			(await run({ argv: JSON.stringify(["true"]), env: "[1]" })).status,
		).toBe(ReceiptStatus.SUCCEEDED);
		const aborted = new AbortController();
		aborted.abort();
		expect(
			(await run({ argv: JSON.stringify(["sleep", "1"]) }, aborted.signal))
				.status,
		).toBe(ReceiptStatus.CANCELLED);
		const failing = await fakeDriver(SandboxTier.S1_CONTAINER).create({
			orderId: "b".repeat(32),
			image: "alpine",
			limits: { memoryMb: 1, cpus: 1, pids: 1, diskMb: 1 },
			egressProxyUrl: "",
			readOnlyMounts: [],
			hostDocker: false,
			fence: async () => false,
		});
		const fenced = await runner.run({
			order: await order({
				argv: JSON.stringify(["curl", `${failing.controlUrl}/fence`]),
			}),
			secret: new Uint8Array(),
			sandbox: failing,
			signal: new AbortController().signal,
			onLog: () => undefined,
			log: () => undefined,
		});
		expect(fenced.status).toBe(ReceiptStatus.FAILED);
	});
});

describe("standing offers when an executor starts (L42)", () => {
	/** A dispatcher whose offer is made before any executor listens. */
	async function offeredBeforeStart() {
		const w = await world(1);
		const member = w.members[0];
		if (member === undefined) throw new Error("no member");
		await w.observe([1]);
		const source = testSource();
		const dispatcher = createDispatcher({
			self: w.dispatchers[0]?.keys ?? member.keys,
			bus: w.bus,
			sources: [source],
			report: reports().report,
			now,
			log: () => undefined,
		});
		const offers: SignedEnvelope[] = [];
		w.bus.offers.subscribe([FLEET], "start", async (envelope) => {
			offers.push(envelope);
		});
		dispatcher.start();
		source.queue.push(upstream("standing", now()));
		await vi.advanceTimersByTimeAsync(5_000);
		expect(offers).toHaveLength(1);
		return { ...w, member, dispatcher, offers };
	}

	it("a new executor claims and runs an offer made before it started", async () => {
		const w = await offeredBeforeStart();
		// Two minutes later, well inside the offer's ten.
		await vi.advanceTimersByTimeAsync(120_000);
		await w.observe([1]);
		const runner = testRunner();
		const executor = w.executor({ member: w.member, slots: 1, runner });
		executor.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runner.ran.map((run) => run.workKey)).toEqual(["standing"]);
		await executor.stop();
		await w.dispatcher.stop();
	});

	it("a restarted executor whose saved position is past a standing offer (a fleet it has just joined) still claims it", async () => {
		const w = await offeredBeforeStart();
		const state = await w.member.store.readState();
		await w.member.store.writeState({
			...state,
			lastSequence: { ...state.lastSequence, offers: 1_000 },
		});
		await w.observe([1]);
		const runner = testRunner();
		const executor = w.executor({ member: w.member, slots: 1, runner });
		executor.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runner.ran.map((run) => run.workKey)).toEqual(["standing"]);
		await executor.stop();
		await w.dispatcher.stop();
	});

	it("handles each standing offer's digest once, however often it is delivered", async () => {
		const w = await offeredBeforeStart();
		await w.dispatcher.stop();
		const [standing] = w.offers;
		if (standing === undefined) throw new Error("no offer");
		// No sandbox tier at all: every offer this executor handles is logged unfit.
		const executor = w.executor({ member: w.member, slots: 1, drivers: [] });
		executor.start();
		await vi.advanceTimersByTimeAsync(1_000);
		await w.bus.offers.publish(standing, FLEET);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(
			w.logs.lines.filter((line) => line.event === "hobo_fleet_offer_unfit"),
		).toHaveLength(1);
		await executor.stop();
	});

	it("skips an offer that no longer stands", async () => {
		const w = await offeredBeforeStart();
		await w.dispatcher.stop();
		await vi.advanceTimersByTimeAsync(11 * 60_000);
		await w.observe([1]);
		const runner = testRunner();
		const executor = w.executor({ member: w.member, slots: 1, runner });
		executor.start();
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runner.ran).toEqual([]);
		await executor.stop();
	});
});
