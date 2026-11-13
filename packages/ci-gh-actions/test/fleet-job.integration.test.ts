/**
 * O24, a GitHub job through the fleet end to end (design §6.9, §10.1): a
 * real `nats-server` (operator mode, JetStream, TLS, the auth callout), the
 * box's dispatcher and an executor device each connected as themselves with
 * `createNatsBusConnector`, the `github-actions-job` work source reading a
 * fake GitHub transport, and the runner in a fake sandbox whose GitHub
 * runner is played by the test (`fleet-work/support/runner-double.ts`).
 *
 * - An internal job: offer, claim, an order whose registration arrives sealed
 *   and reaches the sandbox only through `writeSecret`, the fence allowing
 *   the facts the hook posts, and `STARTED` then `SUCCEEDED` receipts.
 * - A fork job GitHub hands the runner instead: the fence refuses the facts
 *   the hook posts, no step runs, and the receipt is `REFUSED`.
 *
 * The fence in a real sandbox with the real hook is
 * `fleet-fence.integration.test.ts`. `nats-server` is
 * `HOBO_FLEET_NATS_SERVER_BIN` or on PATH; absent, the suite skips outside
 * CI and fails in CI (rule 10 of the design's §11.3).
 */
import { fromBinary } from "@bufbuild/protobuf";
import {
	type FleetBus,
	type ObservedAssignment,
	parseFleetId,
	ReceiptStatus,
	Role,
	SandboxTier,
	WorkOfferSchema,
	WorkOrderSchema,
	WorkOrigin,
	type WorkReceipt,
	WorkReceiptSchema,
} from "@hobo/fleet";
import { createDispatcher, createExecutor } from "@hobo/fleet/work";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createGithubActionsWorkRunner,
	createGithubActionsWorkSource,
} from "../src/fleet-work/index.js";
import { createFakeGithub, queueJob } from "./fleet-work/support/github.js";
import {
	type NatsTenant,
	SKIP_NATS,
	startNatsTenant,
} from "./fleet-work/support/nats.js";
import { githubRunnerDouble } from "./fleet-work/support/runner-double.js";
import {
	device,
	fleetRecord,
	noEgress,
	observe,
	oneSlot,
	publishRecords,
} from "./fleet-work/support/world.js";

const FLEET = parseFleetId("hobo");
let tenant: NatsTenant | undefined;

beforeEach(async () => {
	if (!SKIP_NATS) tenant = await startNatsTenant();
}, 60_000);
afterEach(async () => {
	await tenant?.stop();
	tenant = undefined;
}, 30_000);

async function until(check: () => boolean, ms: number): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check() && Date.now() < deadline)
		await new Promise((resolve) => setTimeout(resolve, 100));
}

async function oneJob(assigned: ObservedAssignment) {
	if (tenant === undefined) throw new Error("no nats-server");
	const now = Date.now();
	const box = await device([Role.DISPATCHER], now);
	const member = await device([Role.EXECUTOR], now);
	await publishRecords(
		tenant.authority,
		tenant.authorityKey,
		[box.record, member.record],
		fleetRecord(now),
	);
	await observe(tenant.authority, member, now);
	const dispatcherBus: FleetBus = await tenant.connect(box.keys);
	const executorBus: FleetBus = await tenant.connect(member.keys);

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
		},
		async mintRegistration(input) {
			minted.push(input.runnerName);
			return {
				ok: true,
				value: new TextEncoder().encode(`jit-for-${input.runnerName}`),
			};
		},
		now: Date.now,
		log: () => undefined,
	});
	const driver = githubRunnerDouble(SandboxTier.S1_CONTAINER, () => ({
		name: "build",
		observed: assigned,
	}));

	const offers: string[] = [];
	const sealed: boolean[] = [];
	const receipts: WorkReceipt[] = [];
	const watching = [
		tenant.authority.offers.subscribe([FLEET], "new", async (envelope) => {
			offers.push(fromBinary(WorkOfferSchema, envelope.payload).workKey);
		}),
		tenant.authority.orders.subscribe(
			member.keys.memberId,
			"new",
			async (envelope) => {
				const order = fromBinary(WorkOrderSchema, envelope.payload);
				// The registration is in the order only as sealed bytes.
				sealed.push(
					order.secret !== undefined &&
						!new TextDecoder().decode(envelope.payload).includes("jit-for-"),
				);
			},
		),
		tenant.authority.events.subscribe(["receipt"], "new", async (event) => {
			receipts.push(fromBinary(WorkReceiptSchema, event.payload));
		}),
	];

	const dispatcher = createDispatcher({
		self: box.keys,
		bus: dispatcherBus,
		sources: [source],
		report: async () => undefined,
		now: Date.now,
		log: () => undefined,
	});
	const executor = createExecutor({
		self: member.keys,
		state: member.store,
		bus: executorBus,
		runners: [createGithubActionsWorkRunner()],
		sandboxes: [driver],
		egress: noEgress(),
		capacity: oneSlot(),
		now: Date.now,
		log: () => undefined,
	});
	executor.start();
	dispatcher.start();
	await until(
		() =>
			receipts.some(
				(receipt) =>
					receipt.memberId === member.keys.memberId &&
					receipt.status !== ReceiptStatus.STARTED,
			),
		60_000,
	);
	await dispatcher.stop();
	await executor.stop();
	for (const subscription of watching) await subscription.stop();
	return {
		job,
		minted,
		driver,
		offers,
		sealed,
		receipts: receipts.filter(
			(receipt) => receipt.memberId === member.keys.memberId,
		),
	};
}

const facts = (origin: WorkOrigin): ObservedAssignment => ({
	workKey: "acme/app/runs/100/attempts/1/jobs/build",
	repository: "acme/app",
	ref: origin === WorkOrigin.FORK ? "refs/pull/5/merge" : "refs/heads/main",
	author: "github:2",
	origin,
});

describe.skipIf(SKIP_NATS)(
	"O24: a GitHub job through the fleet over nats-server",
	() => {
		it("offer, claim, sealed order, fence and a SUCCEEDED receipt for an internal job", async () => {
			const run = await oneJob(facts(WorkOrigin.INTERNAL));
			expect(run.offers).toEqual([`acme/app#${run.job.id}@1`]);
			expect(run.minted).toHaveLength(1);
			expect(run.sealed).toEqual([true]);
			expect([...run.driver.secrets.values()]).toEqual([
				`jit-for-${run.minted[0]}`,
			]);
			expect(run.driver.fenced).toEqual([true]);
			expect(run.driver.stepsRan).toEqual(["build"]);
			expect(run.receipts.map((receipt) => receipt.status)).toEqual([
				ReceiptStatus.STARTED,
				ReceiptStatus.SUCCEEDED,
			]);
		}, 90_000);

		it("a fork job is stopped by the fence before a step runs", async () => {
			const run = await oneJob(facts(WorkOrigin.FORK));
			expect(run.offers).toHaveLength(1);
			expect(run.driver.fenced).toEqual([false]);
			expect(run.driver.stepsRan).toEqual([]);
			expect(run.receipts.at(-1)?.status).toBe(ReceiptStatus.REFUSED);
			expect(run.receipts.at(-1)?.reason).toBe("assignment-mismatch");
		}, 90_000);
	},
);
