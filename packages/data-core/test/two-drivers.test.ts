// Two drivers of one migration. Every fact is a compare-and-set on the head
// the run read, every side effect that moves or releases write authority has
// a fact in front of it, and a batch from a driver that has been superseded
// is refused by the store. So the driver that falls behind stops — and stops
// without touching either store.
import assert from "node:assert/strict";
import type { PrincipalRef } from "@hobo/core";
import { describe, test } from "vitest";
import {
	createEventStoreMigrationJournal,
	createMemoryMigrationJournal,
	type EngineBinding,
	isSupersededError,
	JournalConflictError,
	MIGRATION_EVENTS,
	type MigrationJournal,
	type MigrationRunResult,
	requirePort,
	runOfflineCopy,
	runSnapshotAndTail,
	StaleApplyError,
} from "../src/index.js";
import { createMemoryEventStore } from "./support/memory-event-store.js";
import {
	Authority,
	copyOptions,
	count,
	erase,
	fenced,
	NOW,
	order,
	REALIZATIONS,
	type Stage,
	stage,
	totalOf,
	types,
	writable,
} from "./support/stage.js";

const ACTOR: PrincipalRef = { kind: "system", id: "migration-test" };

const JOURNALS = ["memory", "event-store"] as const;

function journalOf(kind: (typeof JOURNALS)[number]): MigrationJournal {
	return kind === "memory"
		? createMemoryMigrationJournal()
		: createEventStoreMigrationJournal(
				createMemoryEventStore(() => NOW),
				{ tenant: "acme", actor: ACTOR },
			);
}

/** A point one driver waits at until the test lets it go. */
function gate() {
	let open: () => void = () => {};
	let arrive: () => void = () => {};
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	const arrived = new Promise<void>((resolve) => {
		arrive = resolve;
	});
	return {
		/** Called by the stalled driver: tell the test, then wait. */
		async wait(): Promise<void> {
			arrive();
			await opened;
		},
		arrived,
		open: () => open(),
	};
}

type Settled =
	| { readonly result: MigrationRunResult }
	| { readonly error: Error };

function settle(run: Promise<MigrationRunResult>): Promise<Settled> {
	return run.then(
		(result) => ({ result }),
		(error: Error) => ({ error }),
	);
}

function errorOf(outcome: Settled): Error {
	assert.ok("error" in outcome, "the stale driver must not report a result");
	return outcome.error;
}

/**
 * The same stage, with every release of the source's fence recorded. Both
 * drivers in a test are given this source, so a release by either is seen.
 */
function watchingFence(staged: Stage) {
	const fence = requirePort(staged.source, "fence");
	const releases: string[] = [];
	const source: EngineBinding = {
		...staged.source,
		fence: {
			raise: (request) => fence.raise(request),
			status: (scope) => fence.status(scope),
			release: async (request) => {
				releases.push(request.scope.dataset);
				await fence.release(request);
			},
		},
	};
	return { staged: { ...staged, source }, releases };
}

async function cutOvers(journal: MigrationJournal): Promise<number> {
	return (await journal.load("m1")).filter(
		(fact) => fact.type === MIGRATION_EVENTS.CutOver,
	).length;
}

describe("the journal is a compare-and-set on the head a run loaded", () => {
	for (const kind of JOURNALS) {
		test(`${kind}: an append that names a head the journal has moved past is refused, and appends nothing`, async () => {
			const journal = journalOf(kind);
			const fact = (n: number) => ({
				type: MIGRATION_EVENTS.Resumed,
				data: { migrationId: "m1", phase: "seed", resumedAt: `${n}` },
			});
			await journal.append("m1", fact(0), 0);
			await journal.append("m1", fact(1), 1);
			// A driver that loaded one fact, while another appended the second.
			await assert.rejects(
				async () => journal.append("m1", fact(2), 1),
				(cause) =>
					cause instanceof JournalConflictError &&
					cause.code === "JOURNAL_CONFLICT" &&
					cause.expectedCount === 1,
			);
			// Nor may a driver append past a head it has not seen.
			await assert.rejects(
				async () => journal.append("m1", fact(2), 3),
				JournalConflictError,
			);
			assert.equal((await journal.load("m1")).length, 2);
			await journal.append("m1", fact(2), 2);
			assert.deepEqual(
				(await journal.load("m1")).map((entry) => entry.data.resumedAt),
				["0", "1", "2"],
			);
			// Another migration's stream is another head.
			await journal.append("m2", fact(0), 0);
		});

		test(`${kind}: two runs opening the same new migration — one plans it, the other is refused`, async () => {
			const journal = journalOf(kind);
			const staged = await stage("hub");
			const loaded = gate();
			// Both load an empty journal before either appends.
			const slow: MigrationJournal = {
				async load(id) {
					const facts = await journal.load(id);
					await loaded.wait();
					return facts;
				},
				append: (id, fact, expected) => journal.append(id, fact, expected),
			};
			const second = settle(
				runSnapshotAndTail(copyOptions({ ...staged, journal: slow })),
			);
			await loaded.arrived;
			const first = await runSnapshotAndTail(
				copyOptions({ ...staged, journal }, {}, { pauseAfter: "gate" }),
			);
			assert.equal(first.status, "held");
			loaded.open();
			assert.ok(errorOf(await second) instanceof JournalConflictError);
			assert.deepEqual(types(await journal.load("m1")), [
				"Planned",
				"PhaseApplied",
				"Held",
			]);
		});
	}
});

describe("scenario (a): a driver stalled before the cutover, another cuts over", () => {
	for (const realization of REALIZATIONS) {
		for (const kind of JOURNALS) {
			test(`${realization}, ${kind} journal: the stalled driver loses the journal and stops; the old side stays fenced`, async () => {
				const { staged, releases } = watchingFence({
					...(await stage(realization)),
					journal: journalOf(kind),
				});
				const authority = new Authority();
				const stall = gate();
				const ramp: number[] = [];
				// Driver B: stalls inside shift-reads — a slow router call. It
				// loaded the journal before A's cutover.
				const b = settle(
					runSnapshotAndTail(
						copyOptions(staged, {
							flipAuthority: authority.flip,
							soakDecision: () => "hold",
							shiftReads: async (percent) => {
								ramp.push(percent);
								if (percent === 100) await stall.wait();
							},
						}),
					),
				);
				await stall.arrived;
				// Driver A — a retry, a second worker — takes the same migration
				// to the soak window.
				const a = await runSnapshotAndTail(
					copyOptions(staged, {
						flipAuthority: authority.flip,
						soakDecision: () => "hold",
					}),
				);
				assert.equal(a.status, "held");
				assert.equal(a.state.cutOver, true);
				assert.equal(authority.side, "target");
				// The target is the authority now and takes a write.
				await staged.target.records.write({
					dataset: "orders",
					mutations: [order("post-cutover", "42")],
				});
				const journaled = (await staged.journal.load("m1")).length;

				stall.open();
				const error = errorOf(await b);
				assert.ok(error instanceof JournalConflictError, String(error));
				assert.ok(isSupersededError(error));

				// B touched neither store: no fence released, reads not sent
				// home, no fact, no second flip.
				assert.deepEqual(releases, []);
				assert.deepEqual(ramp, [10, 50, 100]);
				assert.equal(authority.side, "target");
				assert.deepEqual(authority.flips, ["to-target"]);
				assert.equal(await fenced(staged.source), true);
				assert.equal(await writable(staged.source), false);
				assert.equal(await writable(staged.target), true);
				assert.equal((await staged.journal.load("m1")).length, journaled);
				assert.equal(await cutOvers(staged.journal), 1);
				assert.equal(await totalOf(staged.target, "post-cutover"), "42");
			});
		}
	}

	test("hub: a driver stalled under its own fence, holding a batch, is refused by the target and never releases the fence", async () => {
		const { staged, releases } = watchingFence(await stage("hub"));
		const authority = new Authority();
		const stall = gate();
		// B gets as far as raising the fence and reading the tail under it,
		// then stalls with that batch in hand.
		let raised = false;
		let stalled = false;
		const fence = requirePort(staged.source, "fence");
		const capture = requirePort(staged.source, "capture");
		const slow: EngineBinding = {
			...staged.source,
			fence: {
				...fence,
				raise: async (request) => {
					const grant = await fence.raise(request);
					raised = true;
					return grant;
				},
			},
			capture: {
				...capture,
				read: async (request) => {
					const batch = await capture.read(request);
					if (raised && !stalled && batch.changes.length > 0) {
						stalled = true;
						await stall.wait();
					}
					return batch;
				},
			},
		};
		const b = settle(
			runSnapshotAndTail(
				copyOptions(
					{ ...staged, source: slow },
					{ flipAuthority: authority.flip, soakDecision: () => "hold" },
					{
						// A write lands on the source just before B fences it, so
						// the tail under the fence has something in it.
						afterPhase: async (phase) => {
							if (phase === "shift-reads") {
								await staged.source.records.write({
									dataset: "orders",
									mutations: [order("late", "1")],
								});
							}
						},
					},
				),
			),
		);
		await stall.arrived;
		assert.equal(await fenced(staged.source), true, "B raised the fence");

		// A new driver picks the migration up and cuts over.
		const a = await runSnapshotAndTail(
			copyOptions(staged, {
				flipAuthority: authority.flip,
				soakDecision: () => "hold",
			}),
		);
		assert.equal(a.status, "held");
		assert.equal(authority.side, "target");
		assert.equal(await totalOf(staged.target, "late"), "1");
		// The authority moves on: the record B still holds is changed and
		// another is erased.
		await staged.target.records.write({
			dataset: "orders",
			mutations: [order("late", "2"), erase("o-2")],
		});
		const journaled = types(await staged.journal.load("m1"));

		stall.open();
		const error = errorOf(await b);
		// The store refused the batch; the run stopped without compensating.
		assert.ok(error instanceof StaleApplyError, String(error));
		assert.deepEqual(releases, [], "the fence was not released");
		assert.equal(await totalOf(staged.target, "late"), "2");
		assert.equal(await totalOf(staged.target, "o-2"), undefined);
		assert.equal(await fenced(staged.source), true);
		assert.equal(await writable(staged.source), false);
		assert.equal(await writable(staged.target), true);
		assert.equal(authority.side, "target");
		assert.deepEqual(types(await staged.journal.load("m1")), journaled);
	});

	test("hub: a driver stalled under its own fence with nothing to apply loses the compensation's compare-and-set, and the fence stays up", async () => {
		const { staged, releases } = watchingFence(await stage("hub"));
		const authority = new Authority();
		const stall = gate();
		let raised = false;
		let stalled = false;
		const fence = requirePort(staged.source, "fence");
		const verify = requirePort(staged.source, "verify");
		// B raises the fence, drains (nothing to apply), and stalls just as it
		// is about to compare the two sides.
		const slow: EngineBinding = {
			...staged.source,
			fence: {
				...fence,
				raise: async (request) => {
					const grant = await fence.raise(request);
					raised = true;
					return grant;
				},
			},
			verify: {
				digest: async (request) => {
					if (raised && !stalled) {
						stalled = true;
						await stall.wait();
					}
					return verify.digest(request);
				},
			},
		};
		const reads: number[] = [];
		const b = settle(
			runSnapshotAndTail(
				copyOptions(
					{ ...staged, source: slow },
					{
						flipAuthority: authority.flip,
						soakDecision: () => "hold",
						shiftReads: (percent) => {
							reads.push(percent);
						},
					},
				),
			),
		);
		await stall.arrived;
		const a = await runSnapshotAndTail(
			copyOptions(staged, {
				flipAuthority: authority.flip,
				soakDecision: () => "hold",
			}),
		);
		assert.equal(a.status, "held");
		// The target takes a write, so B's comparison will now fail — and what
		// B used to do about a failed comparison was release the fence.
		await staged.target.records.write({
			dataset: "orders",
			mutations: [order("post-cutover", "42")],
		});

		stall.open();
		const error = errorOf(await b);
		assert.ok(error instanceof JournalConflictError, String(error));
		assert.deepEqual(releases, []);
		assert.deepEqual(reads, [10, 50, 100], "reads were not sent home either");
		assert.equal(await fenced(staged.source), true);
		assert.equal(await writable(staged.source), false);
		assert.equal(await writable(staged.target), true);
		assert.equal(authority.side, "target");
		assert.equal(await cutOvers(staged.journal), 1);
	});

	test("native: a driver stalled under its own fence finds its transfer closed, cannot record that, and never releases the fence", async () => {
		const { staged, releases } = watchingFence(await stage("native"));
		const authority = new Authority();
		const stall = gate();
		let raised = false;
		let stalled = false;
		const fence = requirePort(staged.source, "fence");
		const transfer = staged.source.nativeTransfer;
		assert.ok(transfer);
		const slow: EngineBinding = {
			...staged.source,
			fence: {
				...fence,
				raise: async (request) => {
					const grant = await fence.raise(request);
					raised = true;
					return grant;
				},
			},
			nativeTransfer: {
				...transfer,
				profiles: transfer.profiles,
				mark: async (request) => {
					const mark = await transfer.mark(request);
					if (raised && !stalled) {
						stalled = true;
						await stall.wait();
					}
					return mark;
				},
			},
		};
		const b = settle(
			runSnapshotAndTail(
				copyOptions(
					{ ...staged, source: slow },
					{ flipAuthority: authority.flip, soakDecision: () => "hold" },
				),
			),
		);
		await stall.arrived;
		const a = await runSnapshotAndTail(
			copyOptions(staged, {
				flipAuthority: authority.flip,
				soakDecision: () => "hold",
				erasures: { since: () => [] },
			}),
		);
		assert.equal(a.status, "held");
		assert.equal(authority.side, "target");
		await staged.target.records.write({
			dataset: "orders",
			mutations: [order("post-cutover", "42")],
		});
		const journaled = types(await staged.journal.load("m1"));

		stall.open();
		const error = errorOf(await b);
		assert.ok(isSupersededError(error), String(error));
		assert.deepEqual(releases, []);
		assert.equal(await fenced(staged.source), true);
		assert.equal(await writable(staged.target), true);
		assert.equal(authority.side, "target");
		assert.deepEqual(types(await staged.journal.load("m1")), journaled);
		assert.equal(await totalOf(staged.target, "post-cutover"), "42");
	});
});

describe("scenario (b): a driver still seeding after another cut over", () => {
	/** A source whose first snapshot chunk is read, then held back. */
	function slowScan(source: EngineBinding, stall: ReturnType<typeof gate>) {
		const snapshot = requirePort(source, "snapshot");
		let first = true;
		const slow: EngineBinding = {
			...source,
			snapshot: {
				openSnapshot: async (request) => {
					const cursor = await snapshot.openSnapshot(request);
					return {
						next: async () => {
							const chunk = await cursor.next();
							if (first) {
								first = false;
								await stall.wait();
							}
							return chunk;
						},
						close: () => cursor.close(),
					};
				},
			},
		};
		return slow;
	}

	test("snapshot-and-tail: the stale chunk is refused by the target — the erased row stays erased, the update stays — and no second cutover is journaled", async () => {
		const staged = await stage("hub");
		const stall = gate();
		const authority = new Authority();
		const b = settle(
			runSnapshotAndTail(
				copyOptions(
					{ ...staged, source: slowScan(staged.source, stall) },
					{ flipAuthority: authority.flip, soakDecision: () => "hold" },
				),
			),
		);
		await stall.arrived;
		const a = await runSnapshotAndTail(
			copyOptions(staged, {
				flipAuthority: authority.flip,
				soakDecision: () => "hold",
			}),
		);
		assert.equal(a.status, "held");
		assert.equal(authority.side, "target");
		// An erasure and an update on the authority.
		await staged.target.records.write({
			dataset: "orders",
			mutations: [erase("o-2"), order("o-1", "100")],
		});
		const journaled = types(await staged.journal.load("m1"));

		stall.open();
		const error = errorOf(await b);
		assert.ok(error instanceof StaleApplyError, String(error));
		assert.equal(error.code, "STALE_APPLY");
		assert.equal(await totalOf(staged.target, "o-2"), undefined);
		assert.equal(await totalOf(staged.target, "o-1"), "100");
		assert.equal(await count(staged.target), 4);
		assert.equal(await cutOvers(staged.journal), 1);
		assert.deepEqual(authority.flips, ["to-target"]);
		assert.deepEqual(types(await staged.journal.load("m1")), journaled);
		assert.equal(await fenced(staged.source), true);
	});

	test("snapshot-and-tail: a chunk read before a change is refused once the tail has applied that change", async () => {
		const staged = await stage("hub");
		const stall = gate();
		const b = settle(
			runSnapshotAndTail(
				copyOptions(
					{ ...staged, source: slowScan(staged.source, stall) },
					{},
					{ pauseAfter: "seed" },
				),
			),
		);
		await stall.arrived;
		// The source changes after B read its chunk…
		await staged.source.records.write({
			dataset: "orders",
			mutations: [order("o-1", "100")],
		});
		// …and A's tail carries the change to the target.
		const a = await runSnapshotAndTail(
			copyOptions(staged, {}, { pauseAfter: "converge" }),
		);
		assert.equal(a.status, "held");
		assert.equal(await totalOf(staged.target, "o-1"), "100");

		stall.open();
		assert.ok(errorOf(await b) instanceof StaleApplyError);
		assert.equal(await totalOf(staged.target, "o-1"), "100");
	});

	test("offline-copy: a stale chunk from a driver that was fenced out is refused", async () => {
		const staged = await stage("hub");
		const stall = gate();
		const authority = new Authority();
		const b = settle(
			runOfflineCopy(
				copyOptions(
					{ ...staged, source: slowScan(staged.source, stall) },
					{ flipAuthority: authority.flip, soakDecision: () => "hold" },
				),
			),
		);
		await stall.arrived;
		const a = await runOfflineCopy(
			copyOptions(staged, {
				flipAuthority: authority.flip,
				soakDecision: () => "hold",
			}),
		);
		assert.equal(a.status, "held");
		assert.equal(authority.side, "target");
		await staged.target.records.write({
			dataset: "orders",
			mutations: [erase("o-2"), order("o-1", "100")],
		});

		stall.open();
		assert.ok(isSupersededError(errorOf(await b)));
		assert.equal(await totalOf(staged.target, "o-2"), undefined);
		assert.equal(await totalOf(staged.target, "o-1"), "100");
		assert.equal(await cutOvers(staged.journal), 1);
		assert.equal(await fenced(staged.source), true);
	});
});
