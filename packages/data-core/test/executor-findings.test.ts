// Regression tests for the reviewed executor defects that are not about two
// drivers or crash windows: the rollback posture, vacuous verification, reads
// left at zero, erasure replay, holds after the flip, a quiet leg's resume
// position, and custody coverage.
import assert from "node:assert/strict";
import type { EventEnvelope, PrincipalRef } from "@hobo/core";
import { describe, test } from "vitest";
import {
	type ChangeEnvelope,
	createMemoryMigrationJournal,
	createReferenceEngine,
	DataCoreError,
	deleteMutation,
	type EngineBinding,
	evaluateCustodyPath,
	evolveMigration,
	foldMigration,
	getPattern,
	initialMigrationState,
	MIGRATION_EVENTS,
	type MigrationFact,
	type MigrationPhase,
	type MigrationRuntime,
	type PivotEvent,
	type PolicyVerdict,
	type ProjectionFold,
	parseCanonicalRecord,
	parseCustodyPath,
	type RecordMutation,
	requirePort,
	runLogPivot,
	runOfflineCopy,
	runRebuildAndSwap,
	runSnapshotAndTail,
	runStreamHandoff,
	scopeOf,
	selectMigrationPattern,
	upsertMutation,
	withoutPorts,
} from "../src/index.js";
import {
	createMemoryEventStore,
	type MemoryEventStore,
} from "./support/memory-event-store.js";
import {
	ALLOW,
	Authority,
	copyOptions,
	count,
	erase,
	fenced,
	keyOf,
	NOW,
	ORDERS,
	order,
	REALIZATIONS,
	runtimeOf,
	stage,
	totalOf,
	types,
} from "./support/stage.js";

const ACTOR: PrincipalRef = { kind: "system", id: "migration-test" };

function factsOf(
	facts: readonly MigrationFact[],
	type: string,
): readonly MigrationFact[] {
	return facts.filter((fact) => fact.type === type);
}

/** A clock that moves one second on every reading. */
function ticking(): () => string {
	let tick = 0;
	return () => {
		tick += 1;
		return new Date(Date.parse(NOW) + tick * 1000).toISOString();
	};
}

// ── finding 3: lossless needs a fence on the target ─────────────────────────

describe("a rollback is lossless only when the target can be fenced", () => {
	test("the catalog names the target's fence among the reverse-tail ports", () => {
		for (const id of ["snapshot-and-tail", "offline-copy"] as const) {
			assert.deepEqual(getPattern(id).reverseTailPorts, {
				source: ["apply"],
				target: ["capture", "fence"],
			});
		}
	});

	for (const run of [runSnapshotAndTail, runOfflineCopy]) {
		test(`${run.name}: a target with capture and no fence reports to-snapshot, and rolls back as such`, async () => {
			const staged = await stage("hub");
			// Capture and apply are both there: the old reading called this a
			// reverse tail, and the rollback lossless.
			const target = withoutPorts(staged.target, ["fence"]);
			const options = copyOptions({ ...staged, target });
			const held = await run({ ...options, soakDecision: () => "hold" });
			assert.equal(held.status, "held");
			assert.equal(held.state.heldAt, "soak");
			assert.equal(held.rollback, "to-snapshot");
			const cutOver = factsOf(held.facts, MIGRATION_EVENTS.CutOver)[0];
			assert.equal(cutOver?.data.reverseTail, false);
			// A write the target acknowledges after the flip is not carried
			// back, and the rollback says so rather than claiming none is lost.
			await target.records.write({
				dataset: "orders",
				mutations: [order("after-flip", "9")],
			});
			const rolled = await run({
				...options,
				soakDecision: () => "rollback",
				erasures: { since: () => [] },
			});
			assert.equal(rolled.status, "rolled-back");
			assert.match(rolled.reason ?? "", /writes since .* are lost/u);
			const fact = factsOf(rolled.facts, MIGRATION_EVENTS.RolledBack)[0];
			assert.equal(fact?.data.lossless, false);
			assert.equal(await totalOf(staged.source, "after-flip"), undefined);
		});
	}

	test("with the fence the same pair is lossless, and the target is fenced while authority goes back", async () => {
		const staged = await stage("hub");
		const authority = new Authority();
		const options = copyOptions(staged, { flipAuthority: authority.flip });
		const held = await runSnapshotAndTail({
			...options,
			soakDecision: () => "hold",
		});
		assert.equal(held.rollback, "lossless");
		await staged.target.records.write({
			dataset: "orders",
			mutations: [order("after-flip", "9")],
		});
		let targetFencedAtFlip: boolean | undefined;
		const rolled = await runSnapshotAndTail({
			...options,
			soakDecision: () => "rollback",
			flipAuthority: async (flip) => {
				if (flip.direction === "to-source") {
					targetFencedAtFlip = await fenced(staged.target);
				}
				authority.flip(flip);
			},
		});
		assert.equal(rolled.status, "rolled-back");
		assert.equal(targetFencedAtFlip, true);
		assert.equal(await totalOf(staged.source, "after-flip"), "9");
	});

	test("the selector agrees: no fence on the target, no reverse tail and a to-snapshot soak", () => {
		const select = (target: EngineBinding) =>
			selectMigrationPattern({
				authority: "authoritative",
				change: "engine",
				source: createReferenceEngine({ engine: "alpha" }).declaration,
				target: target.declaration,
				schema: ORDERS,
				constraints: { maxWriteFreezeMs: 5_000, requiredRollback: "none" },
				estimates: { flipMs: 1_000, copyMs: 600_000 },
				verdict: ALLOW,
				evidence: ["alpha", "beta"].map((engine) => ({
					engine,
					outcome: "pass" as const,
					checkedAt: NOW,
				})),
				now: NOW,
				evidenceMaxAgeMs: 24 * 60 * 60 * 1000,
			}).candidates.find(
				(entry) =>
					entry.pattern === "snapshot-and-tail" && entry.realization === "hub",
			);
		const beta = createReferenceEngine({ engine: "beta" });
		const fenceless = select(withoutPorts(beta, ["fence"]));
		assert.equal(fenceless?.eligible, true);
		assert.equal(fenceless?.reverseTail, false);
		assert.equal(fenceless?.rollbackInSoak, "to-snapshot");
		const fenceable = select(beta);
		assert.equal(fenceable?.reverseTail, true);
		assert.equal(fenceable?.rollbackInSoak, "lossless");
	});
});

// ── finding 6: erasure replay ───────────────────────────────────────────────

describe("erasure replay is fail-closed and windowed from before the fence", () => {
	for (const realization of REALIZATIONS) {
		test(`${realization}: without a ledger a to-snapshot rollback holds — nothing is rolled back and nothing is claimed`, async () => {
			const staged = await stage(realization, {
				targetOmit: realization === "hub" ? ["capture"] : [],
			});
			const authority = new Authority();
			const options = copyOptions(staged, { flipAuthority: authority.flip });
			await runSnapshotAndTail({ ...options, soakDecision: () => "hold" });
			await staged.target.records.write({
				dataset: "orders",
				mutations: [erase("o-2")],
			});
			const held = await runSnapshotAndTail({
				...options,
				soakDecision: () => "rollback",
			});
			assert.equal(held.status, "held");
			assert.match(held.reason ?? "", /no erasure ledger was supplied/u);
			assert.equal(held.state.rollbackDecided, false);
			assert.equal(authority.side, "target");
			assert.equal(await fenced(staged.source), true);
			assert.equal(await fenced(staged.target), false);
			assert.deepEqual(factsOf(held.facts, MIGRATION_EVENTS.RolledBack), []);
			// With the ledger the same run goes through, and the subject erased
			// on the authority stays erased on the restored one.
			const rolled = await runSnapshotAndTail({
				...options,
				soakDecision: () => "rollback",
				erasures: { since: () => [erase("o-2")] },
			});
			assert.equal(rolled.status, "rolled-back");
			assert.equal(await totalOf(staged.source, "o-2"), undefined);
			const fact = factsOf(rolled.facts, MIGRATION_EVENTS.RolledBack)[0];
			assert.equal(fact?.data.erasuresReplayed, 1);
		});
	}

	test("an erasure recorded while the source was fenced — before the cutover instant — is replayed", async () => {
		const staged = await stage("hub", { targetOmit: ["capture"] });
		const clock = ticking();
		const options = copyOptions(staged, {}, { clock });
		const held = await runSnapshotAndTail({
			...options,
			soakDecision: () => "hold",
		});
		const requested = String(
			factsOf(held.facts, MIGRATION_EVENTS.FenceRequested)[0]?.data.requestedAt,
		);
		const cutOver = factsOf(held.facts, MIGRATION_EVENTS.CutOver)[0];
		const cutOverAt = String(cutOver?.data.cutOverAt);
		assert.ok(
			requested < cutOverAt,
			"the fence was requested before the cutover",
		);
		assert.equal(cutOver?.data.fencedFrom, requested);
		// The ledger holds one erasure, dated inside the fence window: after
		// the fence was requested, before the cutover was decided. The source
		// refused it; it landed on the target once writes moved there.
		const entry = { at: requested, mutation: erase("o-3") };
		assert.ok(entry.at < cutOverAt);
		await staged.target.records.write({
			dataset: "orders",
			mutations: [entry.mutation],
		});
		const asked: string[] = [];
		const rolled = await runSnapshotAndTail({
			...options,
			soakDecision: () => "rollback",
			erasures: {
				since: (instant) => {
					asked.push(instant);
					return entry.at >= instant ? [entry.mutation] : [];
				},
			},
		});
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(asked, [requested], "windowed from the fence request");
		assert.equal(
			await totalOf(staged.source, "o-3"),
			undefined,
			"the subject erased during the fence window came back",
		);
		const decided = factsOf(rolled.facts, MIGRATION_EVENTS.RollbackDecided)[0];
		assert.equal(decided?.data.erasuresFrom, requested);
	});
});

// ── finding 5: reads after a compensation ───────────────────────────────────

describe("a compensated cutover puts reads back before it flips", () => {
	test("reads go 10, 50, 100, home to 0 on the failed verification, and back to 100 before authority moves", async () => {
		const staged = await stage("hub");
		const reads: number[] = [];
		const readsAtFlip: number[] = [];
		const options = copyOptions(staged, {
			shiftReads: (percent) => {
				reads.push(percent);
			},
			flipAuthority: () => {
				readsAtFlip.push(reads[reads.length - 1] ?? -1);
			},
		});
		// A record the migration did not put there: verification under the
		// fence fails once.
		const held = await runSnapshotAndTail({
			...options,
			runtime: runtimeOf(staged.journal, {
				afterPhase: async (phase) => {
					if (phase === "shift-reads") {
						await staged.target.records.write({
							dataset: "orders",
							mutations: [order("stray", "1")],
						});
					}
				},
			}),
		});
		assert.equal(held.status, "held");
		assert.equal(held.state.heldAt, "shift-reads");
		assert.deepEqual(reads, [10, 50, 100, 0]);
		assert.equal(await fenced(staged.source), false);
		const compensation = factsOf(held.facts, MIGRATION_EVENTS.Held)[0];
		assert.equal(compensation?.data.compensated, true);

		await staged.target.records.write({
			dataset: "orders",
			mutations: [erase("stray")],
		});
		const done = await runSnapshotAndTail(options);
		assert.equal(done.status, "completed", done.reason);
		assert.deepEqual(reads, [10, 50, 100, 0, 100]);
		assert.deepEqual(readsAtFlip, [100], "authority moved with reads at 100");
	});

	test("a run that never compensated does not touch the ramp again", async () => {
		const staged = await stage("hub");
		const reads: number[] = [];
		const done = await runSnapshotAndTail(
			copyOptions(staged, {
				shiftReads: (percent) => {
					reads.push(percent);
				},
			}),
		);
		assert.equal(done.status, "completed");
		assert.deepEqual(reads, [10, 50, 100]);
	});
});

// ── M9: a quiet leg's durable resume position ───────────────────────────────

describe("a quiet scope still advances its durable resume position", () => {
	test("changes outside a tenant-scoped tail move the leg's watermark, though nothing is applied", async () => {
		const source = createReferenceEngine({ engine: "source" });
		const target = createReferenceEngine({ engine: "target" });
		await source.datasets.ensureDataset(ORDERS);
		await source.records.write({
			dataset: "orders",
			mutations: [order("a-1", "1", "acme"), order("b-1", "1", "other")],
		});
		const journal = createMemoryMigrationJournal();
		const options = (pauseAfter: MigrationPhase) => ({
			runtime: runtimeOf(journal, { pauseAfter }),
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders", "acme"),
			flipAuthority: () => {},
		});
		const watermark = () =>
			requirePort(target, "apply").watermark({
				dataset: "orders",
				source: "hobo_migration_m1_forward",
			});
		assert.equal(
			(await runSnapshotAndTail(options("converge"))).status,
			"held",
		);
		const before = await watermark();
		// The tenant being moved is quiet; another tenant keeps writing, and
		// the source's log moves on.
		const receipt = await source.records.write({
			dataset: "orders",
			mutations: [order("b-2", "2", "other"), order("b-3", "3", "other")],
		});
		assert.equal((await runSnapshotAndTail(options("verify"))).status, "held");
		const after = await watermark();
		assert.notEqual(after, before, "the watermark did not move");
		assert.ok(
			after?.endsWith(`@${receipt.position}`),
			`the leg's durable position (${after}) is the source's head (${receipt.position})`,
		);
		// And nothing of the other tenant crossed.
		assert.equal(
			(
				await requirePort(target, "verify").digest({
					scope: scopeOf("orders"),
					buckets: 4,
				})
			).count,
			1,
		);
	});
});

// ── the fence across a restart ──────────────────────────────────────────────

describe("a cutover fence that is gone is not quietly raised again", () => {
	test("a resume that finds the decided fence down holds for a person; it neither flips nor re-fences the store", async () => {
		const staged = await stage("hub");
		const authority = new Authority();
		// The process dies right after the decision is journaled…
		await assert.rejects(
			runSnapshotAndTail(
				copyOptions(staged, {
					flipAuthority: () => {
						throw new Error("process died at the flip");
					},
				}),
			),
			/process died/u,
		);
		// …and the engine's fence does not survive the restart.
		const fence = requirePort(staged.source, "fence");
		const grant = await fence.raise({ scope: scopeOf("orders"), reason: "t" });
		await fence.release({
			scope: scopeOf("orders"),
			fenceToken: grant.fenceToken,
		});
		const resumed = await runSnapshotAndTail(
			copyOptions(staged, { flipAuthority: authority.flip }),
		);
		assert.equal(resumed.status, "held");
		assert.match(resumed.reason ?? "", /no longer raised/u);
		assert.deepEqual(authority.flips, [], "authority did not move");
		assert.equal(
			await fenced(staged.source),
			false,
			"the run must not put a fresh fence on a store that may be the authority",
		);
	});
});

// ── finding 10: holds after the flip, and absorbing terminal states ─────────

describe("a hold after fence-and-flip is a fact", () => {
	const toEvents = (change: ChangeEnvelope): readonly PivotEvent[] => {
		// SAFETY: the canonical key of the orders schema is a one-element array.
		const [id] = JSON.parse(change.key) as [string];
		return change.op === "delete" || change.record === undefined
			? [{ streamId: `order:${id}`, type: "order.Removed", data: { id } }]
			: [
					{
						streamId: `order:${id}`,
						type: "order.Recorded",
						data: { id, total: String(change.record.total) },
					},
				];
	};
	const fold: ProjectionFold = {
		name: "orders-pivot",
		project(event: EventEnvelope): readonly RecordMutation[] {
			// SAFETY: pivot events carry the bodies `toEvents` built above.
			const data = event.data as { id: string; total?: string };
			const record = parseCanonicalRecord(ORDERS, {
				id: data.id,
				total: data.total ?? "0",
			});
			const key = keyOf(data.id);
			return event.type === "order.Recorded"
				? [upsertMutation("", key, record)]
				: [deleteMutation("", key)];
		},
	};

	async function pivot(
		runtime: MigrationRuntime,
		source: EngineBinding,
		target: EngineBinding,
		log: MemoryEventStore,
		projection: ProjectionFold = fold,
	) {
		return runLogPivot({
			runtime,
			source,
			schema: ORDERS,
			scope: scopeOf("orders"),
			log,
			toEvents,
			append: { actor: ACTOR, tenant: "acme" },
			fold: projection,
			target,
			targetSchema: ORDERS,
			targetScope: scopeOf("orders"),
			flipAuthority: () => {},
		});
	}

	const deny: PolicyVerdict = {
		...ALLOW,
		ok: false,
		findings: [
			{
				code: "CUSTODY_RETENTION_EXPIRED",
				point: "relay",
				role: "relay",
				detail: "",
				remediation: "",
			},
		],
	};

	test("log-pivot: a verdict that turns negative before finalize is recorded as Held, and the run resumes when it clears", async () => {
		const staged = await stage("hub");
		const log = createMemoryEventStore(() => NOW);
		let allowed = false;
		const runtime = runtimeOf(staged.journal, {
			policy: (phase) => (phase === "finalize" && !allowed ? deny : ALLOW),
		});
		const held = await pivot(runtime, staged.source, staged.target, log);
		assert.equal(held.status, "held");
		assert.equal(held.phase, "fence-and-flip");
		// Authority moved into the log at the flip; it does not come back.
		assert.equal(held.rollback, "none");
		assert.match(held.reason ?? "", /CUSTODY_RETENTION_EXPIRED/u);
		const fact = factsOf(held.facts, MIGRATION_EVENTS.Held)[0];
		assert.deepEqual(
			{ phase: fact?.data.phase, before: fact?.data.before },
			{ phase: "fence-and-flip", before: "finalize" },
		);
		assert.equal(held.state.status, "held");
		assert.deepEqual(factsOf(held.facts, MIGRATION_EVENTS.Failed), []);

		allowed = true;
		const done = await pivot(runtime, staged.source, staged.target, log);
		assert.equal(done.status, "completed");
		assert.deepEqual(types(done.facts).slice(-4), [
			"Held",
			"Resumed",
			"PhaseApplied",
			"Completed",
		]);
	});

	test("stream-handoff: pausing after the flip is a recorded hold with the rollback that remains", async () => {
		const source = createMemoryEventStore(() => NOW);
		await source.append(
			"order:1",
			[{ type: "order.Placed", data: { id: "1" } }],
			{ expectedSeq: 0, actor: ACTOR, tenant: "acme" },
		);
		const target = createMemoryEventStore(() => NOW);
		const journal = createMemoryMigrationJournal();
		const handoff = (pauseAfter?: MigrationPhase) =>
			runStreamHandoff({
				runtime: runtimeOf(
					journal,
					pauseAfter === undefined ? {} : { pauseAfter },
				),
				source,
				target,
				quiesce: () => {
					source.quiesced = true;
					return { fenceToken: "epoch-2" };
				},
				unquiesce: () => {
					source.quiesced = false;
				},
				flipWriter: () => {},
			});
		const held = await handoff("fence-and-flip");
		assert.equal(held.status, "held");
		assert.equal(held.rollback, "to-snapshot");
		const fact = factsOf(held.facts, MIGRATION_EVENTS.Held)[0];
		assert.deepEqual(
			{ phase: fact?.data.phase, before: fact?.data.before },
			{ phase: "fence-and-flip", before: "finalize" },
		);
		assert.equal((await handoff()).status, "completed");
	});

	test("snapshot-and-tail keeps its name for the same place: the soak window", async () => {
		const staged = await stage("hub");
		const held = await runSnapshotAndTail(
			copyOptions(staged, {}, { pauseAfter: "fence-and-flip" }),
		);
		assert.equal(held.status, "held");
		assert.equal(held.state.heldAt, "soak");
		assert.equal(held.rollback, "lossless");
	});

	test("the fold's terminal states are absorbing: nothing appended later reopens a finished migration", () => {
		const fact = (type: string, data: Record<string, string> = {}) => ({
			type,
			data: { migrationId: "m", ...data },
		});
		const late = [
			fact(MIGRATION_EVENTS.Held, { phase: "soak", reason: "late" }),
			fact(MIGRATION_EVENTS.PhaseApplied, { phase: "seed" }),
			fact(MIGRATION_EVENTS.Failed, { reason: "Error" }),
			fact(MIGRATION_EVENTS.Resumed, { phase: "seed" }),
			fact(MIGRATION_EVENTS.CutOver),
			fact(MIGRATION_EVENTS.RollbackDecided),
			fact(MIGRATION_EVENTS.Planned, { pattern: "offline-copy" }),
		];
		for (const terminal of [
			MIGRATION_EVENTS.Completed,
			MIGRATION_EVENTS.RolledBack,
		]) {
			const finished = foldMigration("m", [
				fact(MIGRATION_EVENTS.Planned, { pattern: "snapshot-and-tail" }),
				fact(MIGRATION_EVENTS.PhaseApplied, { phase: "gate" }),
				fact(terminal),
			]);
			for (const next of late) {
				assert.equal(
					evolveMigration(finished, next),
					finished,
					`${terminal} then ${next.type}`,
				);
			}
			assert.equal(
				foldMigration("m", [
					fact(MIGRATION_EVENTS.Planned),
					fact(terminal),
					...late,
				]).status,
				finished.status,
			);
		}
		// Failure is not terminal: a crash is resumed.
		const failed = evolveMigration(
			evolveMigration(
				initialMigrationState("m"),
				fact(MIGRATION_EVENTS.Failed),
			),
			fact(MIGRATION_EVENTS.PhaseApplied, { phase: "gate" }),
		);
		assert.equal(failed.status, "running");
	});

	test("a finished run is not re-entered even when a stray fact follows its last one", async () => {
		const staged = await stage("hub");
		const authority = new Authority();
		const options = copyOptions(staged, { flipAuthority: authority.flip });
		assert.equal((await runSnapshotAndTail(options)).status, "completed");
		const facts = await staged.journal.load("m1");
		await staged.journal.append(
			"m1",
			{
				type: MIGRATION_EVENTS.Failed,
				data: { migrationId: "m1", reason: "Error", failedAt: NOW },
			},
			facts.length,
		);
		const again = await runSnapshotAndTail(options);
		assert.equal(again.status, "completed");
		assert.deepEqual(authority.flips, ["to-target"]);
	});

	// ── finding 4: log-pivot never verifies vacuously ────────────────────────

	test("log-pivot with an unchanged schema and a source that cannot digest is refused before anything is journaled", async () => {
		const staged = await stage("hub", { sourceOmit: ["verify"] });
		const log = createMemoryEventStore(() => NOW);
		await assert.rejects(
			pivot(runtimeOf(staged.journal), staged.source, staged.target, log),
			(cause) =>
				cause instanceof DataCoreError && cause.code === "PORT_MISSING",
		);
		assert.deepEqual(await staged.journal.load("m1"), []);
		assert.equal(log.size(), 0);
	});

	test("log-pivot with a fold that drops records holds; Verified with compared:true is only ever written after a real comparison", async () => {
		const staged = await stage("hub", { rows: 6 });
		const log = createMemoryEventStore(() => NOW);
		// A broken fold: it silently drops every other record.
		const lossy: ProjectionFold = {
			name: "orders-pivot",
			project(event) {
				// SAFETY: pivot events carry the bodies `toEvents` built above.
				const data = event.data as { id: string };
				return Number(data.id.slice(2)) % 2 === 1
					? []
					: fold.project(event, async () => undefined);
			},
		};
		const held = await pivot(
			runtimeOf(staged.journal),
			staged.source,
			staged.target,
			log,
			lossy,
		);
		assert.equal(held.status, "held");
		assert.match(held.reason ?? "", /does not digest equal/u);
		assert.deepEqual(factsOf(held.facts, MIGRATION_EVENTS.Verified), []);
		assert.equal(await count(staged.target), 3);
		assert.equal(
			await fenced(staged.source),
			false,
			"the store stays writable",
		);

		// The honest case: the comparison is made, and the fact says so.
		const other = await stage("hub", { rows: 6 });
		const done = await pivot(
			runtimeOf(other.journal),
			other.source,
			other.target,
			createMemoryEventStore(() => NOW),
		);
		assert.equal(done.status, "completed");
		assert.equal(
			factsOf(done.facts, MIGRATION_EVENTS.Verified)[0]?.data.compared,
			true,
		);
	});
});

// ── rebuild-and-swap: a sink behind the log is not verified ─────────────────

describe("rebuild-and-swap verifies only a sink that has reached the log head", () => {
	test("with no previous sink to compare against, a sink still behind holds instead of being called verified", async () => {
		const log = createMemoryEventStore(() => NOW);
		const place = (id: string) =>
			log.append(`order:${id}`, [{ type: "order.Placed", data: { id } }], {
				expectedSeq: 0,
				actor: ACTOR,
				tenant: "acme",
			});
		await place("o-1");
		const fold: ProjectionFold = {
			name: "orders-projection",
			project(event) {
				// SAFETY: test events carry the JSON bodies appended above.
				const data = event.data as { id: string };
				return [
					upsertMutation(
						"",
						keyOf(data.id),
						parseCanonicalRecord(ORDERS, { id: data.id, total: "1" }),
					),
				];
			},
		};
		const target = createReferenceEngine({ engine: "sink" });
		const journal = createMemoryMigrationJournal();
		const result = await runRebuildAndSwap({
			runtime: runtimeOf(journal, {
				// The log runs ahead once the sink has converged: more events
				// than one round of one event can fold.
				afterPhase: async (phase) => {
					if (phase !== "converge") return;
					for (const id of ["o-2", "o-3", "o-4", "o-5", "o-6"]) await place(id);
				},
			}),
			log,
			fold,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			batch: 1,
			maxRounds: 1,
			verifyRechecks: 1,
		});
		assert.equal(result.status, "held");
		assert.equal(result.state.heldAt, "converge");
		assert.match(result.reason ?? "", /still ahead of the new sink/u);
		assert.equal(result.state.checkpoints.verify, undefined);
	});
});

// ── custody coverage ────────────────────────────────────────────────────────

describe("a run holds on a verdict that does not cover the copies it creates", () => {
	const endsOnly = evaluateCustodyPath({
		path: parseCustodyPath({
			points: [
				{ id: "s", role: "source", region: "eu-west-1", protections: [] },
				{ id: "t", role: "target", region: "eu-west-1", protections: [] },
			],
		}),
		policy: { classification: "public" },
		now: NOW,
	});

	for (const realization of REALIZATIONS) {
		test(`${realization}: a positive verdict over source and target alone holds the run before it touches a store, and says which roles were never judged`, async () => {
			assert.equal(endsOnly.ok, true, "the verdict itself is positive");
			const staged = await stage(realization);
			const result = await runSnapshotAndTail(
				copyOptions(staged, {}, { policy: () => endsOnly }),
			);
			assert.equal(result.status, "held");
			assert.equal(result.phase, "plan");
			assert.match(result.reason ?? "", /CUSTODY_PATH_INCOMPLETE/u);
			assert.match(result.reason ?? "", /retiring-source/u);
			assert.match(
				result.reason ?? "",
				realization === "hub" ? /relay/u : /capture-log/u,
			);
			assert.deepEqual(types(result.facts), ["Planned", "Held"]);
			assert.equal(
				await staged.target.datasets.describeDataset("orders"),
				undefined,
				"nothing was provisioned",
			);
			// The same run over a path that names every role goes through.
			const done = await runSnapshotAndTail(copyOptions(staged));
			assert.equal(done.status, "completed", done.reason);
		});
	}

	test("a verdict that predates the roles member names none, and covers nothing", async () => {
		const staged = await stage("hub");
		const { roles: _roles, ...legacy } = ALLOW;
		const result = await runSnapshotAndTail(
			copyOptions(
				staged,
				{},
				{
					// SAFETY: a verdict as it would arrive from evidence recorded before `roles` existed.
					policy: () => legacy as PolicyVerdict,
				},
			),
		);
		assert.equal(result.status, "held");
		assert.match(result.reason ?? "", /CUSTODY_PATH_INCOMPLETE/u);
	});
});
