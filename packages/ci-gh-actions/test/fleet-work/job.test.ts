/**
 * One GitHub job through the fleet on the in-memory bus (design §6.9, the
 * isolated check of L16): the work source reads a fake GitHub, the dispatcher
 * offers the job, the executor claims it, the order carries the sealed
 * registration, the hook's facts pass the start fence and the receipt says
 * `SUCCEEDED`. A fork job that GitHub hands the same runner is stopped by the
 * fence from the facts the hook posts, before any step runs.
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type ObservedAssignment,
	parseFleetId,
	ReceiptStatus,
	Role,
	SandboxTier,
	WorkOfferSchema,
	WorkOrigin,
	type WorkReceipt,
	WorkReceiptSchema,
} from "@hobo/fleet";
import { createMemoryBus } from "@hobo/fleet/testing";
import { createDispatcher, createExecutor } from "@hobo/fleet/work";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGithubActionsWorkRunner,
	createGithubActionsWorkSource,
} from "../../src/fleet-work/index.js";
import { GITHUB_RUNNER_IMAGE } from "../../src/fleet-work/runner.js";
import { createFakeGithub, queueJob } from "./support/github.js";
import { githubRunnerDouble } from "./support/runner-double.js";
import {
	authorityKey,
	device,
	fleetRecord,
	noEgress,
	observe,
	oneSlot,
	seed,
} from "./support/world.js";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const now = () => Date.now();

beforeEach(() => {
	vi.useFakeTimers({ now: NOW });
});
afterEach(() => {
	vi.useRealTimers();
});

async function world(assigned: () => ObservedAssignment) {
	const bus = createMemoryBus(now);
	const dispatcherDevice = await device([Role.DISPATCHER], NOW);
	const executorDevice = await device([Role.EXECUTOR], NOW);
	await seed(
		bus,
		authorityKey(),
		[dispatcherDevice.record, executorDevice.record],
		fleetRecord(NOW),
	);
	await observe(bus, executorDevice, NOW);
	const github = createFakeGithub();
	const { job } = queueJob(github, { actorId: 2 });
	const minted: string[] = [];
	const source = createGithubActionsWorkSource({
		poller: {
			github,
			connections: async () => [
				{ installationId: 7, repositoryId: 42, repository: "acme/app" },
			],
			ingest: async () => "accepted",
			now,
		},
		async mintRegistration(input) {
			minted.push(input.runnerName);
			return {
				ok: true,
				value: new TextEncoder().encode(`jit-for-${input.runnerName}`),
			};
		},
		now,
		log: () => undefined,
	});
	const driver = githubRunnerDouble(SandboxTier.S1_CONTAINER, () => ({
		name: "build",
		observed: assigned(),
	}));
	const offers: string[] = [];
	bus.offers.subscribe([parseFleetId("hobo")], "start", async (envelope) => {
		offers.push(fromBinary(WorkOfferSchema, envelope.payload).workKey);
	});
	const receipts: WorkReceipt[] = [];
	bus.events.subscribe(["receipt"], "start", async (event) => {
		receipts.push(fromBinary(WorkReceiptSchema, event.payload));
	});
	const egress = noEgress();
	const dispatcher = createDispatcher({
		self: dispatcherDevice.keys,
		bus,
		sources: [source],
		report: async () => undefined,
		now,
		log: () => undefined,
	});
	const executor = createExecutor({
		self: executorDevice.keys,
		state: executorDevice.store,
		bus,
		runners: [createGithubActionsWorkRunner()],
		sandboxes: [driver],
		egress,
		capacity: oneSlot(),
		now,
		log: () => undefined,
	});
	return {
		job,
		minted,
		driver,
		offers,
		receipts,
		egress,
		async run() {
			executor.start();
			await vi.advanceTimersByTimeAsync(10);
			dispatcher.start();
			for (let step = 0; step < 12; step += 1) {
				await vi.advanceTimersByTimeAsync(5_000);
				if (
					receipts.some((receipt) => receipt.status !== ReceiptStatus.STARTED)
				)
					break;
			}
			await dispatcher.stop();
			await executor.stop();
		},
	};
}

const facts = (origin: WorkOrigin, job: number): ObservedAssignment => ({
	workKey: `acme/app/runs/100/attempts/1/jobs/build-${job}`,
	repository: "acme/app",
	ref: origin === WorkOrigin.FORK ? "refs/pull/5/merge" : "refs/heads/main",
	author: "github:2",
	origin,
});

describe("a github-actions-job through the fleet on the memory bus", () => {
	it("offer, claim, sealed order, fence and a SUCCEEDED receipt for an internal job", async () => {
		const w = await world(() => facts(WorkOrigin.INTERNAL, 1));
		await w.run();
		expect(w.offers).toEqual([`acme/app#${w.job.id}@1`]);
		expect(w.minted).toHaveLength(1);
		// The registration reached the sandbox sealed, and only through writeSecret.
		const registration = [...w.driver.secrets.values()];
		expect(registration).toEqual([`jit-for-${w.minted[0]}`]);
		expect(w.driver.images).toEqual([GITHUB_RUNNER_IMAGE]);
		expect(w.egress.opened[0]).toContain("api.github.com");
		expect(w.driver.fenced).toEqual([true]);
		expect(w.driver.stepsRan).toEqual(["build"]);
		expect(w.receipts.map((receipt) => receipt.status)).toEqual([
			ReceiptStatus.STARTED,
			ReceiptStatus.SUCCEEDED,
		]);
		// GitHub may hand the runner another job of its label; the receipt names the one run.
		expect(w.receipts[1]?.observedWorkKey).toBe(
			facts(WorkOrigin.INTERNAL, 1).workKey,
		);
	});

	it("a fork job GitHub hands the runner is stopped by the fence before its first step", async () => {
		const w = await world(() => facts(WorkOrigin.FORK, 2));
		await w.run();
		expect(w.offers).toHaveLength(1);
		expect(w.driver.fenced).toEqual([false]);
		expect(w.driver.stepsRan).toEqual([]);
		const final = w.receipts.at(-1);
		expect(final?.status).toBe(ReceiptStatus.REFUSED);
		expect(final?.reason).toBe("assignment-mismatch");
	});
});
