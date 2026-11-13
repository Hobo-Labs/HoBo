// ReconcilerTransport conformance (plan 0024 D5, I4, I12). One fenced lease
// per Camp, a cursor feed of desired state after the committed checkpoint,
// and reports that a stale holder can never land.
import type { EventPosition } from "@hobo/core";
import {
	type CdConformanceReport,
	type CdSuiteOptions,
	check,
	checkTypedRefusal,
	runCdAssertions,
} from "./cd-kit.js";
import type {
	DesiredStateChangeLike,
	Outcome,
	ReconcilerLeaseLike,
	ReconcilerTransportLike,
} from "./cd-shapes.js";

// public-contract: versioned conformance suite id stamped on CD conformance reports.
export const RECONCILER_TRANSPORT_SUITE = "hobo.cd.reconciler-transport/v1";

// public-contract: assertion names of the ReconcilerTransport suite.
export const RECONCILER_TRANSPORT_ASSERTIONS = Object.freeze([
	"claimGrantsLease",
	"oneWriterPerCamp",
	"fenceIncreasesOnReclaim",
	"staleFenceIsRefused",
	"renewExtendsLease",
	"expiredLeaseIsReclaimable",
	"feedResumesAfterCheckpoint",
	"checkpointNeverRegresses",
] as const);
export type ReconcilerTransportAssertion =
	(typeof RECONCILER_TRANSPORT_ASSERTIONS)[number];

export interface ReconcilerTransportWorld<
	TLease extends ReconcilerLeaseLike,
	TObs,
> {
	transport: ReconcilerTransportLike<TLease, TObs>;
	/** Advance the transport's injected clock. */
	advance(ms: number): void;
	/** Record desired Set number `n` for the Camp (one spec-stream change). */
	publish(n: number): Promise<void>;
	/** A valid observation for the lease. */
	observation(lease: TLease): TObs;
}

export interface ReconcilerTransportHarness<
	TLease extends ReconcilerLeaseLike,
	TObs,
> {
	readonly subject: string;
	readonly campId: string;
	readonly reconcilerId: string;
	readonly ttlMs: number;
	create(): Promise<ReconcilerTransportWorld<TLease, TObs>>;
}

/** Read up to `count` changes, bounded by `waitMs` of idleness. */
export async function takeChanges(
	feed: (signal: AbortSignal) => AsyncIterable<DesiredStateChangeLike>,
	count: number,
	waitMs = 250,
): Promise<readonly DesiredStateChangeLike[]> {
	const controller = new AbortController();
	const out: DesiredStateChangeLike[] = [];
	const iterator = feed(controller.signal)[Symbol.asyncIterator]();
	try {
		while (out.length < count) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const idle = new Promise<"idle">((resolve) => {
				timer = setTimeout(() => resolve("idle"), waitMs);
			});
			const next = await Promise.race([iterator.next(), idle]);
			if (timer !== undefined) clearTimeout(timer);
			if (next === "idle" || next.done) break;
			out.push(next.value);
		}
	} finally {
		controller.abort();
		void iterator.return?.();
	}
	return out;
}

function leaseOf<T>(outcome: Outcome<T>, what: string): T {
	check(
		outcome.ok,
		`${what} was refused`,
		"a free Camp's lease is granted to the first claimant",
	);
	if (!outcome.ok) throw new Error(what);
	return outcome.value;
}

export async function runReconcilerTransportConformance<
	TLease extends ReconcilerLeaseLike,
	TObs,
>(
	harness: ReconcilerTransportHarness<TLease, TObs>,
	options?: CdSuiteOptions,
): Promise<CdConformanceReport<ReconcilerTransportAssertion>> {
	const claim = (
		world: ReconcilerTransportWorld<TLease, TObs>,
		holderId: string,
	) =>
		world.transport.claim({
			reconcilerId: harness.reconcilerId,
			campId: harness.campId,
			holderId,
			ttlMs: harness.ttlMs,
		});
	return runCdAssertions<ReconcilerTransportAssertion>(
		RECONCILER_TRANSPORT_SUITE,
		harness.subject,
		{
			claimGrantsLease: async () => {
				const world = await harness.create();
				const lease = leaseOf(
					await claim(world, "holder-a"),
					"the first claim",
				);
				check(
					lease.campId === harness.campId,
					"lease names another Camp",
					"the lease is keyed by Camp (I4)",
				);
				check(
					lease.holderId === "holder-a",
					"lease names another holder",
					"echo the holder",
				);
				check(
					lease.fence > 0n,
					"lease fence is not positive",
					"fences start above zero and only grow",
				);
			},
			oneWriterPerCamp: async () => {
				const world = await harness.create();
				leaseOf(await claim(world, "holder-a"), "the first claim");
				checkTypedRefusal(
					await claim(world, "holder-b"),
					"a second holder's claim on a leased Camp",
				);
			},
			fenceIncreasesOnReclaim: async () => {
				const world = await harness.create();
				const first = leaseOf(
					await claim(world, "holder-a"),
					"the first claim",
				);
				await world.transport.release(first);
				const second = leaseOf(
					await claim(world, "holder-b"),
					"the claim after release",
				);
				check(
					second.fence > first.fence,
					`fence ${second.fence} does not exceed ${first.fence}`,
					"every grant takes a strictly greater fence (I4)",
				);
			},
			staleFenceIsRefused: async () => {
				const world = await harness.create();
				const stale = leaseOf(
					await claim(world, "holder-a"),
					"the first claim",
				);
				world.advance(harness.ttlMs + 1);
				const fresh = leaseOf(
					await claim(world, "holder-b"),
					"the claim after expiry",
				);
				checkTypedRefusal(
					await world.transport.report(stale, world.observation(stale)),
					"a report under a stale fence",
				);
				await world.publish(1);
				const [change] = await takeChanges(
					(signal) => world.transport.feed({ lease: fresh, signal }),
					1,
				);
				check(
					change !== undefined,
					"the new holder's feed is empty",
					"the feed carries the Camp's desired state",
				);
				if (change)
					checkTypedRefusal(
						await world.transport.checkpoint(stale, change.position),
						"a checkpoint under a stale fence",
					);
				const renewed = await world.transport.renew(stale);
				checkTypedRefusal(renewed, "renewing a superseded lease");
			},
			renewExtendsLease: async () => {
				const world = await harness.create();
				const lease = leaseOf(
					await claim(world, "holder-a"),
					"the first claim",
				);
				world.advance(Math.floor(harness.ttlMs / 2));
				const renewed = leaseOf(
					await world.transport.renew(lease),
					"renewal by the holder",
				);
				check(
					renewed.expiresAtMs > lease.expiresAtMs,
					"renewal did not extend the lease",
					"renew moves expiry forward",
				);
				check(
					renewed.fence === lease.fence,
					"renewal changed the fence",
					"renewal keeps the holder's fence",
				);
			},
			expiredLeaseIsReclaimable: async () => {
				const world = await harness.create();
				leaseOf(await claim(world, "holder-a"), "the first claim");
				world.advance(harness.ttlMs + 1);
				leaseOf(
					await claim(world, "holder-b"),
					"a claim after the holder's lease expired",
				);
			},
			feedResumesAfterCheckpoint: async () => {
				const world = await harness.create();
				await world.publish(1);
				await world.publish(2);
				const lease = leaseOf(
					await claim(world, "holder-a"),
					"the first claim",
				);
				const changes = await takeChanges(
					(signal) => world.transport.feed({ lease, signal }),
					2,
				);
				check(
					changes.length === 2,
					`feed delivered ${changes.length} of 2 changes`,
					"deliver every change after the checkpoint",
				);
				const [first] = changes;
				if (!first) return;
				leaseOf(
					await world.transport.report(lease, world.observation(lease)),
					"a report by the holder",
				);
				leaseOf(
					await world.transport.checkpoint(lease, first.position),
					"a checkpoint by the holder",
				);
				await world.transport.release(lease);
				const next = leaseOf(
					await claim(world, "holder-b"),
					"the claim after release",
				);
				const resumed = await takeChanges(
					(signal) => world.transport.feed({ lease: next, signal }),
					2,
				);
				check(
					resumed.length >= 1,
					"feed after checkpoint is empty",
					"resume from the committed checkpoint",
				);
				check(
					resumed.every((change) => change.position > first.position),
					"feed replayed a checkpointed change",
					"the feed starts strictly after the committed checkpoint",
				);
			},
			checkpointNeverRegresses: async () => {
				const world = await harness.create();
				await world.publish(1);
				await world.publish(2);
				const lease = leaseOf(
					await claim(world, "holder-a"),
					"the first claim",
				);
				const [a, b] = await takeChanges(
					(signal) => world.transport.feed({ lease, signal }),
					2,
				);
				if (!a || !b) violationEmpty();
				else {
					leaseOf(
						await world.transport.checkpoint(lease, b.position),
						"checkpoint at the second change",
					);
					const back = await world.transport.checkpoint(lease, a.position);
					const committed: EventPosition | undefined = back.ok
						? back.value
						: undefined;
					check(
						!back.ok || committed === b.position,
						`checkpoint regressed to ${committed}`,
						"refuse or ignore a checkpoint behind the committed one",
					);
				}
			},
		},
		options,
	);
}

function violationEmpty(): void {
	check(
		false,
		"feed delivered fewer than 2 changes",
		"deliver every change after the checkpoint",
	);
}
