// A crash between any two side effects — in the cutover, a compensation, a
// rollback, or the finalize — must resume to one consistent outcome: exactly
// one writable side, or a hold a later run can leave.
//
// The crashes here are injected through the ports, the journal and the
// caller's callbacks, at every side effect in turn, both before it ran and
// after it ran but before anyone heard back. `afterPhase` alone would only
// ever stop a run *after* a fact was journaled — the one place a crash is
// harmless.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	type CopyMigrationOptions,
	type EngineBinding,
	MIGRATION_EVENTS,
	type MigrationRunResult,
	requirePort,
	runOfflineCopy,
	runSnapshotAndTail,
	type SoakDecision,
} from "../src/index.js";
import {
	Authority,
	Chaos,
	CRASH_MODES,
	type CrashMode,
	chaotic,
	chaoticJournal,
	copyOptions,
	count,
	erase,
	fenced,
	order,
	REALIZATIONS,
	type Realization,
	type Stage,
	stage,
	totalOf,
	types,
} from "./support/stage.js";

type Runner = (options: CopyMigrationOptions) => Promise<MigrationRunResult>;

interface World {
	readonly staged: Stage;
	readonly authority: Authority;
	readonly reads: number[];
}

async function world(
	realization: Realization,
	targetOmit: readonly "capture"[] = [],
): Promise<World> {
	return {
		staged: await stage(realization, { rows: 5, targetOmit }),
		authority: new Authority(),
		reads: [],
	};
}

/** One run of the migration, every side effect through `chaos`. */
function attempt(
	run: Runner,
	at: World,
	chaos: Chaos,
	extra: Partial<CopyMigrationOptions>,
): Promise<MigrationRunResult> {
	const { staged, authority, reads } = at;
	return run(
		copyOptions(
			{
				...staged,
				source: chaotic(staged.source, "source", chaos),
				target: chaotic(staged.target, "target", chaos),
				journal: chaoticJournal(staged.journal, chaos),
			},
			{
				flipAuthority: (flip) =>
					chaos.effect(`flip ${flip.direction}`, () => authority.flip(flip)),
				shiftReads: (percent) =>
					chaos.effect(`reads ${percent}`, () => {
						reads.push(percent);
					}),
				...extra,
			},
		),
	);
}

/**
 * What must hold at every moment, crashed or not: the two stores are never
 * both taking writes once authority has moved. With authority on the target
 * the source is fenced; once authority has been on the target and is back on
 * the source, the target is fenced.
 */
async function assertNeverTwoWriters(at: World, where: string): Promise<void> {
	const { staged, authority } = at;
	const sourceFenced = await fenced(staged.source);
	const targetFenced = await fenced(staged.target);
	if (authority.side === "target") {
		assert.equal(
			sourceFenced,
			true,
			`${where}: authority is on the target and the source is not fenced`,
		);
	} else if (authority.everOnTarget) {
		assert.equal(
			targetFenced,
			true,
			`${where}: authority went back to the source and the target is not fenced`,
		);
	}
}

/** Exactly one side writable: the authority, and only the authority. */
async function assertOneWriter(at: World, where: string): Promise<void> {
	const { staged, authority } = at;
	const sourceFenced = await fenced(staged.source);
	const targetFenced = await fenced(staged.target);
	assert.deepEqual(
		{ source: !sourceFenced, target: !targetFenced },
		{
			source: authority.side === "source",
			target: authority.side === "target",
		},
		`${where}: exactly the authority (${authority.side}) must be writable`,
	);
}

/** Run until the migration reports a terminal status, as a supervisor would. */
async function resumeToEnd(
	run: Runner,
	at: World,
	extra: Partial<CopyMigrationOptions>,
	where: string,
): Promise<MigrationRunResult> {
	let last: MigrationRunResult | undefined;
	for (let round = 0; round < 6; round += 1) {
		last = await attempt(run, at, new Chaos(), extra);
		await assertNeverTwoWriters(at, `${where}, resume ${round}`);
		if (last.status !== "held") return last;
	}
	assert.fail(
		`${where}: still held after six resumes: ${last?.reason ?? ""} [${types(last?.facts ?? []).join(" ")}]`,
	);
}

interface Scenario {
	readonly name: string;
	readonly realization: Realization;
	readonly run: Runner;
	readonly targetOmit?: readonly "capture"[];
	/** Bring a fresh world to where the crashing run starts. */
	readonly prepare?: (at: World) => Promise<void>;
	/** The run crashes are injected into. */
	readonly crashing: Partial<CopyMigrationOptions>;
	/** What the supervisor asks for on every resume. */
	readonly resuming: Partial<CopyMigrationOptions>;
	/** Runs between the crash and the first resume. */
	readonly repair?: (at: World) => Promise<void>;
	readonly settled: (
		at: World,
		result: MigrationRunResult,
		where: string,
	) => Promise<void>;
}

const soak = (decision: SoakDecision): Partial<CopyMigrationOptions> => ({
	soakDecision: () => decision,
});

/** A crash-free run of the scenario: how many side effects there are. */
async function effects(scenario: Scenario): Promise<Chaos> {
	const at = await world(scenario.realization, scenario.targetOmit);
	await scenario.prepare?.(at);
	const chaos = new Chaos();
	await attempt(scenario.run, at, chaos, scenario.crashing);
	return chaos;
}

async function sweep(scenario: Scenario): Promise<number> {
	const baseline = await effects(scenario);
	assert.ok(baseline.calls > 5, "the scenario has side effects to crash at");
	let crashes = 0;
	for (const mode of CRASH_MODES) {
		for (let at = 1; at <= baseline.calls; at += 1) {
			await crashAt(scenario, at, mode, baseline.trace[at - 1] ?? "?");
			crashes += 1;
		}
	}
	return crashes;
}

async function crashAt(
	scenario: Scenario,
	index: number,
	mode: CrashMode,
	effect: string,
): Promise<void> {
	const where = `${scenario.name} — crash ${mode} #${index} (${effect})`;
	const at = await world(scenario.realization, scenario.targetOmit);
	await scenario.prepare?.(at);
	const chaos = new Chaos(index, mode);
	await assert.rejects(
		attempt(scenario.run, at, chaos, scenario.crashing),
		(cause) => cause instanceof Error,
		`${where}: the run must not report a result once the process is dead`,
	);
	assert.equal(chaos.dead, true, `${where}: the crash fired`);
	await assertNeverTwoWriters(at, `${where}, after the crash`);
	await scenario.repair?.(at);
	const result = await resumeToEnd(scenario.run, at, scenario.resuming, where);
	await scenario.settled(at, result, where);
}

/** The forward path ended: the target is the authority, the source retired. */
async function assertCompleted(
	at: World,
	result: MigrationRunResult,
	where: string,
	rows: number,
): Promise<void> {
	assert.equal(result.status, "completed", `${where}: ${result.reason ?? ""}`);
	assert.equal(at.authority.side, "target", where);
	assert.equal(await count(at.staged.target), rows, `${where}: target rows`);
	assert.equal(await count(at.staged.source), 0, `${where}: source retired`);
	await assertOneWriter(at, where);
	const facts = await at.staged.journal.load("m1");
	assert.equal(
		facts.filter((fact) => fact.type === MIGRATION_EVENTS.CutOver).length,
		1,
		`${where}: the cutover was decided once`,
	);
	assert.equal(
		facts.filter((fact) => fact.type === MIGRATION_EVENTS.Completed).length,
		1,
		where,
	);
}

/** Reach the soak window, and let the new authority take a write. */
async function toSoak(run: Runner, at: World): Promise<void> {
	const held = await attempt(run, at, new Chaos(), soak("hold"));
	assert.equal(held.status, "held");
	assert.equal(at.authority.side, "target");
	await at.staged.target.records.write({
		dataset: "orders",
		mutations: [order("after-flip", "9"), erase("o-2")],
	});
}

describe("a crash at every side effect of the forward path", () => {
	for (const realization of REALIZATIONS) {
		test(`snapshot-and-tail, ${realization}: resumes to completed — one cutover, source retired, target the only writer`, async () => {
			const crashes = await sweep({
				name: `snapshot-and-tail/${realization}`,
				realization,
				run: runSnapshotAndTail,
				crashing: soak("finalize"),
				resuming: soak("finalize"),
				settled: (at, result, where) => assertCompleted(at, result, where, 5),
			});
			assert.ok(crashes >= 40, `only ${crashes} crash points`);
		});

		test(`offline-copy, ${realization}: resumes to completed`, async () => {
			await sweep({
				name: `offline-copy/${realization}`,
				realization,
				run: runOfflineCopy,
				crashing: soak("finalize"),
				resuming: soak("finalize"),
				settled: (at, result, where) => assertCompleted(at, result, where, 5),
			});
		});
	}

	test("snapshot-and-tail, hub, no reverse tail: a crash after the retire committed resumes to completed, not to a hold", async () => {
		await sweep({
			name: "snapshot-and-tail/hub/no-reverse-tail",
			realization: "hub",
			targetOmit: ["capture"],
			run: runSnapshotAndTail,
			crashing: soak("finalize"),
			resuming: soak("finalize"),
			settled: (at, result, where) => assertCompleted(at, result, where, 5),
		});
	});
});

describe("a crash at every side effect of a compensation", () => {
	test("snapshot-and-tail, hub: the source ends up the only writer and held; once the cause is gone the next run completes with reads back on the target", async () => {
		// A record that appears on the target behind the migration's back, so
		// the comparison under the fence fails and the run compensates.
		const stray = async (at: World): Promise<void> => {
			await at.staged.target.records.write({
				dataset: "orders",
				mutations: [order("stray", "1")],
			});
		};
		// Reach shift-reads cleanly, then plant the stray: the crashing run
		// is the one that fences, fails verification, and compensates.
		const reachRamp = async (at: World): Promise<void> => {
			const paused = await runSnapshotAndTail(
				copyOptions(
					at.staged,
					{
						flipAuthority: at.authority.flip,
						shiftReads: (percent) => {
							at.reads.push(percent);
						},
					},
					{ pauseAfter: "shift-reads" },
				),
			);
			assert.equal(paused.status, "held");
			await stray(at);
		};
		const baseline = await (async () => {
			const at = await world("hub");
			await reachRamp(at);
			const chaos = new Chaos();
			const held = await attempt(runSnapshotAndTail, at, chaos, {});
			assert.equal(held.status, "held");
			assert.match(held.reason ?? "", /exact verification under the fence/u);
			// The source is the authority and writable again; nothing moved.
			assert.equal(at.authority.side, "source");
			assert.equal(await fenced(at.staged.source), false);
			assert.deepEqual(at.reads, [10, 50, 100, 0]);
			return chaos;
		})();
		for (const mode of CRASH_MODES) {
			for (let index = 1; index <= baseline.calls; index += 1) {
				const where = `compensation — crash ${mode} #${index} (${baseline.trace[index - 1]})`;
				const at = await world("hub");
				await reachRamp(at);
				await assert.rejects(
					attempt(runSnapshotAndTail, at, new Chaos(index, mode), {}),
				);
				await assertNeverTwoWriters(at, `${where}, after the crash`);
				assert.equal(at.authority.side, "source", where);
				// The cause goes away, and the supervisor runs it again.
				await at.staged.target.records.write({
					dataset: "orders",
					mutations: [erase("stray")],
				});
				const result = await resumeToEnd(
					runSnapshotAndTail,
					at,
					soak("finalize"),
					where,
				);
				await assertCompleted(at, result, where, 5);
				// Reads were sent home by the compensation (when it got that
				// far); the cutover put them back before authority moved.
				assert.equal(
					at.reads[at.reads.length - 1],
					100,
					`${where}: reads ended at ${at.reads.join(",")}`,
				);
			}
		}
	});
});

describe("a crash at every side effect of a rollback", () => {
	test("lossless (reverse tail): ends rolled back with the source the only writer and nothing lost — or, if the crash came before the decision, wherever the next decision takes it", async () => {
		for (const resumeDecision of ["rollback", "finalize"] as const) {
			await sweep({
				name: `lossless rollback, resumed with ${resumeDecision}`,
				realization: "hub",
				run: runSnapshotAndTail,
				prepare: (at) => toSoak(runSnapshotAndTail, at),
				crashing: soak("rollback"),
				resuming: soak(resumeDecision),
				settled: async (at, result, where) => {
					const facts = await at.staged.journal.load("m1");
					const decided = facts.some(
						(fact) => fact.type === MIGRATION_EVENTS.RollbackDecided,
					);
					if (resumeDecision === "rollback" || decided) {
						// A journaled rollback is finished whatever is asked next.
						assert.equal(result.status, "rolled-back", where);
						assert.equal(at.authority.side, "source", where);
						await assertOneWriter(at, where);
						// Lossless: the write the target took, and its erasure.
						assert.equal(await totalOf(at.staged.source, "after-flip"), "9");
						assert.equal(await totalOf(at.staged.source, "o-2"), undefined);
						assert.equal(await count(at.staged.source), 5, where);
						assert.equal(
							facts.filter((fact) => fact.type === MIGRATION_EVENTS.RolledBack)
								.length,
							1,
							where,
						);
						return;
					}
					// The crash fell before any rollback was decided, and the
					// supervisor chose to finalize instead.
					await assertCompleted(at, result, where, 5);
				},
			});
		}
	});

	for (const realization of REALIZATIONS) {
		test(`to-snapshot (${realization}, no reverse tail): ends rolled back with the source the only writer and the erased subject still erased`, async () => {
			const ledger = { erasures: { since: () => [erase("o-2")] } };
			for (const resumeDecision of ["rollback", "finalize"] as const) {
				await sweep({
					name: `to-snapshot rollback/${realization}, resumed with ${resumeDecision}`,
					realization,
					targetOmit: realization === "hub" ? ["capture"] : [],
					run: runSnapshotAndTail,
					prepare: (at) => toSoak(runSnapshotAndTail, at),
					crashing: { ...soak("rollback"), ...ledger },
					resuming: { ...soak(resumeDecision), ...ledger },
					settled: async (at, result, where) => {
						const facts = await at.staged.journal.load("m1");
						const decided = facts.some(
							(fact) => fact.type === MIGRATION_EVENTS.RollbackDecided,
						);
						if (resumeDecision === "rollback" || decided) {
							assert.equal(result.status, "rolled-back", where);
							assert.equal(result.rollback, "none", where);
							assert.equal(at.authority.side, "source", where);
							await assertOneWriter(at, where);
							assert.equal(
								await totalOf(at.staged.source, "o-2"),
								undefined,
								`${where}: the erased subject came back`,
							);
							// Stale by design: the write made after the flip is lost.
							assert.equal(
								await totalOf(at.staged.source, "after-flip"),
								undefined,
							);
							return;
						}
						await assertCompleted(at, result, where, 5);
					},
				});
			}
		});
	}

	test("a rollback whose journal append fails after authority moved back is finished, not re-run: no second soak, no released target", async () => {
		// The reviewer's case: flip to the source and release its fence, then
		// die before RolledBack is journaled.
		const at = await world("hub");
		await toSoak(runSnapshotAndTail, at);
		const dying = {
			load: (id: string) => at.staged.journal.load(id),
			append: (
				...args: Parameters<typeof at.staged.journal.append>
			): ReturnType<typeof at.staged.journal.append> => {
				if (args[1].type === MIGRATION_EVENTS.RolledBack) {
					throw new Error("process died before RolledBack was journaled");
				}
				return at.staged.journal.append(...args);
			},
		};
		await assert.rejects(
			runSnapshotAndTail(
				copyOptions(
					{ ...at.staged, journal: dying },
					{ flipAuthority: at.authority.flip, ...soak("rollback") },
				),
			),
			/process died/u,
		);
		assert.equal(at.authority.side, "source");
		assert.equal(await fenced(at.staged.source), false);
		assert.equal(await fenced(at.staged.target), true);
		// The source is the authority again and takes a write.
		await at.staged.source.records.write({
			dataset: "orders",
			mutations: [order("after-rollback", "3")],
		});
		for (const decision of ["finalize", "rollback", "hold"] as const) {
			let asked = 0;
			const result = await runSnapshotAndTail(
				copyOptions(at.staged, {
					flipAuthority: at.authority.flip,
					soakDecision: () => {
						asked += 1;
						return decision;
					},
				}),
			);
			assert.equal(result.status, "rolled-back", decision);
			assert.equal(asked, 0, "a journaled rollback is not put to the question");
			assert.equal(at.authority.side, "source");
			assert.equal(await fenced(at.staged.source), false);
			assert.equal(await fenced(at.staged.target), true, "target stays fenced");
			assert.equal(await totalOf(at.staged.source, "after-rollback"), "3");
			assert.equal(await count(at.staged.source), 6, "nothing was retired");
		}
		assert.equal(
			(await at.staged.journal.load("m1")).filter(
				(fact) => fact.type === MIGRATION_EVENTS.RolledBack,
			).length,
			1,
		);
	});
});

describe("a crash between retire and the finalize fact", () => {
	for (const reverse of [true, false]) {
		for (const realization of REALIZATIONS) {
			if (realization === "native" && reverse) continue;
			test(`${realization}, ${reverse ? "with" : "without"} a reverse tail: the resume finds the source retired and completes`, async () => {
				const at = await world(
					realization,
					reverse || realization === "native" ? [] : ["capture"],
				);
				const retire = requirePort(at.staged.source, "retire");
				let crash = true;
				const dying: EngineBinding = {
					...at.staged.source,
					retire: {
						retire: async (request) => {
							const receipt = await retire.retire(request);
							if (crash) {
								crash = false;
								throw new Error("process died after retire committed");
							}
							return receipt;
						},
					},
				};
				await assert.rejects(
					runSnapshotAndTail(
						copyOptions(
							{ ...at.staged, source: dying },
							{ flipAuthority: at.authority.flip },
						),
					),
					/process died after retire/u,
				);
				assert.equal(await count(at.staged.source), 0);
				assert.equal(await count(at.staged.target), 5);
				for (let again = 0; again < 2; again += 1) {
					const result = await runSnapshotAndTail(
						copyOptions(at.staged, { flipAuthority: at.authority.flip }),
					);
					assert.equal(result.status, "completed", result.reason);
				}
				await assertOneWriter(at, "after retire crash");
			});
		}
	}
});
