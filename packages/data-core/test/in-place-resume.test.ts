import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	createMemoryMigrationJournal,
	DataCoreError,
	type InPlaceEvolveOptions,
	JournalConflictError,
	MIGRATION_EVENTS,
	type MigrationJournal,
	NO_ERASURE_REPLAY_REASON,
	PHASE_OUTCOME_UNKNOWN,
	PHASE_REAPPLY_FAILED,
	type PolicyOutcome,
	runInPlaceEvolve,
	type SchemaApplyPort,
	type SchemaPhase,
	type SchemaSnapshotRef,
} from "../src/index.js";
import { NOW, types } from "./support/stage.js";

class FakeStore implements SchemaApplyPort {
	applied: string[] = [];
	readonly calls: string[] = [];
	readonly restored: string[] = [];
	private readonly snapshots = new Map<string, string[]>();
	violations: readonly { id: string }[] = [];

	snapshot(): SchemaSnapshotRef {
		const ref = `snap-${this.snapshots.size + 1}`;
		this.snapshots.set(ref, [...this.applied]);
		this.calls.push(`snapshot:${ref}`);
		return { ref, takenAt: NOW };
	}

	applyPhase(phase: SchemaPhase, statements: readonly string[]) {
		this.calls.push(`apply:${phase}`);
		for (const statement of statements) {
			if (statement.startsWith("FAIL")) {
				throw new Error(
					`${statement}: duplicate column name: email_new [dsn=postgres://app:hunter2@db.internal/prod]`,
				);
			}
			if (this.applied.includes(statement)) {
				throw new Error(`duplicate column name: ${statement}`);
			}
			this.applied.push(statement);
		}
		return { phase, statements: statements.length, changes: 0 };
	}

	verify(query = "") {
		if (query.startsWith("PENDING ")) {
			const statement = query.slice("PENDING ".length);
			return this.applied.includes(statement) ? [] : [{ id: statement }];
		}
		return this.violations;
	}

	restore(ref: SchemaSnapshotRef): void {
		const state = this.snapshots.get(ref.ref);
		if (state === undefined) throw new Error("no such snapshot");
		this.applied = [...state];
		this.restored.push(ref.ref);
	}
}

const PLAN = {
	migrationId: "evolve",
	expand: ["ADD email_new"],
	backfill: ["FILL email_new"],
	contract: ["DROP email"],
	verify: { afterBackfill: "SELECT 1", afterContract: "SELECT 2" },
};

const PROBES = {
	expand: "PENDING ADD email_new",
	backfill: "PENDING FILL email_new",
	contract: "PENDING DROP email",
};

const COVERED = ["source", "rollback-snapshot"];
const allow: PolicyOutcome = { ok: true, findings: [], roles: COVERED };
const deny: PolicyOutcome = {
	ok: false,
	findings: [{ code: "CUSTODY_RETENTION_EXPIRED" }],
	roles: COVERED,
};

function options(
	port: SchemaApplyPort,
	journal: MigrationJournal | undefined,
	extra: Partial<InPlaceEvolveOptions> = {},
): InPlaceEvolveOptions {
	return {
		port,
		plan: PLAN,
		clock: () => NOW,
		compatGate: () => ({
			gateId: "g",
			consumersOnLegacySchema: [],
			verifiedAt: NOW,
		}),
		replayErasures: () => 0,
		...(journal === undefined ? undefined : { journal }),
		...extra,
	};
}

describe("in-place-evolve resumes from its journal", () => {
	test("a hold before backfill, then a clear verdict: expand is not applied again, and one snapshot is taken", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		let verdict = deny;
		const policy = (phase: SchemaPhase) =>
			phase === "backfill" ? verdict : allow;
		const held = await runInPlaceEvolve(options(store, journal, { policy }));
		assert.equal(held.status, "held");
		assert.deepEqual(store.calls, ["snapshot:snap-1", "apply:expand"]);

		verdict = allow;
		const done = await runInPlaceEvolve(options(store, journal, { policy }));
		assert.equal(done.status, "completed");
		assert.deepEqual(store.calls, [
			"snapshot:snap-1",
			"apply:expand",
			"apply:backfill",
			"apply:contract",
		]);
		assert.deepEqual(store.applied, [
			"ADD email_new",
			"FILL email_new",
			"DROP email",
		]);
		assert.equal(done.snapshot?.ref, "snap-1");
		assert.deepEqual(
			done.phases.map((phase) => phase.phase),
			["expand", "backfill", "contract"],
		);
		assert.deepEqual(types(done.facts), [
			"Planned",
			"SnapshotTaken",
			"PhaseIntended",
			"PhaseApplied",
			"Held",
			"Resumed",
			"PhaseIntended",
			"PhaseApplied",
			"Verified",
			"PhaseIntended",
			"PhaseApplied",
			"Verified",
			"CutOver",
		]);
	});

	test("the reviewer's case: without a journal the same re-run applies expand twice — with one it cannot", async () => {
		const forgetful = new FakeStore();
		let verdict = deny;
		const policy = (phase: SchemaPhase) =>
			phase === "backfill" ? verdict : allow;
		await runInPlaceEvolve(options(forgetful, undefined, { policy }));
		verdict = allow;
		const again = await runInPlaceEvolve(
			options(forgetful, undefined, { policy }),
		);
		assert.equal(again.status, "rolled-back");
		assert.deepEqual(forgetful.calls, [
			"snapshot:snap-1",
			"apply:expand",
			"snapshot:snap-2",
			"apply:expand",
		]);
		assert.deepEqual(forgetful.restored, ["snap-2"]);
		assert.deepEqual(forgetful.applied, ["ADD email_new"]);
	});

	test("a failure after a resume restores the first snapshot — the one taken before anything changed", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		let verdict = deny;
		const policy = (phase: SchemaPhase) =>
			phase === "backfill" ? verdict : allow;
		await runInPlaceEvolve(options(store, journal, { policy }));
		verdict = allow;
		const replayed: string[] = [];
		const rolled = await runInPlaceEvolve(
			options(store, journal, {
				policy,
				plan: { ...PLAN, contract: ["FAIL contract"] },
				replayErasures: (snapshot) => {
					replayed.push(snapshot.ref);
					return 2;
				},
			}),
		);
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(store.restored, ["snap-1"]);
		assert.deepEqual(store.applied, [], "the store is as it was before");
		assert.deepEqual(replayed, ["snap-1"]);
		assert.equal(
			store.calls.filter((call) => call.startsWith("snapshot")).length,
			1,
		);
	});

	test("a hold with the dual window open resumes at the contract phase and rechecks backfill", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		let consumers: readonly string[] = ["billing"];
		const gated = (): InPlaceEvolveOptions =>
			options(store, journal, {
				compatGate: () => ({
					gateId: "g",
					consumersOnLegacySchema: consumers,
					verifiedAt: NOW,
				}),
			});
		const blocked = await runInPlaceEvolve(gated());
		assert.equal(blocked.status, "contract-blocked");
		assert.equal(blocked.dualWindowOpen, true);
		consumers = [];
		const done = await runInPlaceEvolve(gated());
		assert.equal(done.status, "completed");
		assert.deepEqual(store.calls, [
			"snapshot:snap-1",
			"apply:expand",
			"apply:backfill",
			"apply:contract",
		]);
		assert.equal(
			done.facts.filter(
				(fact) =>
					fact.type === MIGRATION_EVENTS.Verified &&
					fact.data.point === "after-backfill",
			).length,
			2,
		);
	});

	test("a finished migration run again is a no-op, completed or rolled back", async () => {
		for (const plan of [PLAN, { ...PLAN, backfill: ["FAIL backfill"] }]) {
			const store = new FakeStore();
			const journal = createMemoryMigrationJournal();
			const first = await runInPlaceEvolve(options(store, journal, { plan }));
			const calls = [...store.calls];
			const facts = (await journal.load("evolve")).length;
			const second = await runInPlaceEvolve(options(store, journal, { plan }));
			assert.equal(second.status, first.status);
			assert.deepEqual(store.calls, calls);
			assert.equal((await journal.load("evolve")).length, facts);
		}
	});

	test("two runs of one migration: the one whose view is stale sees it has been overtaken and applies nothing more", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		let overtake: (() => Promise<void>) | undefined;
		const slow = runInPlaceEvolve(
			options(store, journal, {
				compatGate: async () => {
					await overtake?.();
					return { gateId: "g", consumersOnLegacySchema: [], verifiedAt: NOW };
				},
			}),
		);
		overtake = async () => {
			overtake = undefined;
			const other = await runInPlaceEvolve(options(store, journal));
			assert.equal(other.status, "completed");
		};
		await assert.rejects(slow, JournalConflictError);
		assert.equal(
			store.calls.filter((call) => call === "apply:contract").length,
			1,
		);
		assert.deepEqual(store.restored, []);
	});

	test("a stale run whose phase fails does not restore the snapshot over a migration another run completed", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		const real = store.applyPhase.bind(store);
		let overtaken = false;
		const plan = { ...PLAN, probes: PROBES };
		const racing: SchemaApplyPort = {
			snapshot: () => store.snapshot(),
			verify: (query) => store.verify(query),
			restore: (ref) => store.restore(ref),
			applyPhase: async (phase, statements) => {
				if (phase === "contract" && !overtaken) {
					overtaken = true;
					const other = await runInPlaceEvolve(
						options(store, journal, { plan }),
					);
					assert.equal(other.status, "completed");
				}
				return real(phase, statements);
			},
		};
		await assert.rejects(
			runInPlaceEvolve(options(racing, journal, { plan })),
			JournalConflictError,
		);
		assert.deepEqual(
			store.restored,
			[],
			"the completed migration was restored away",
		);
		assert.deepEqual(store.applied, [
			"ADD email_new",
			"FILL email_new",
			"DROP email",
		]);
		const facts = await journal.load("evolve");
		assert.equal(facts[facts.length - 1]?.type, MIGRATION_EVENTS.CutOver);
	});

	test("a restore is decided before it is done, and a crash in between is resumed by restoring", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		const plan = { ...PLAN, backfill: ["FAIL backfill"] };
		const real = store.restore.bind(store);
		store.restore = () => {
			throw new Error("process died before the restore ran");
		};
		const failed = await runInPlaceEvolve(options(store, journal, { plan }));
		assert.equal(failed.status, "failed");
		assert.deepEqual(types(failed.facts).slice(-2), [
			"RollbackDecided",
			"Failed",
		]);
		store.restore = real;
		const rolled = await runInPlaceEvolve(options(store, journal));
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(store.restored, ["snap-1"]);
		assert.deepEqual(store.applied, []);
	});
});

describe("in-place-evolve erasure replay is fail-closed", () => {
	test("with no erasure replay wired, a failed phase holds and restores nothing; given one, the next run restores", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		const failing = { ...PLAN, backfill: ["FAIL backfill"] };
		const { replayErasures: _unwired, ...bare } = options(store, journal, {
			plan: failing,
		});
		const held = await runInPlaceEvolve(bare);
		assert.equal(held.status, "held");
		assert.deepEqual(store.restored, [], "nothing was restored");
		assert.deepEqual(store.applied, ["ADD email_new"]);
		assert.equal(held.blockedReasons[1], NO_ERASURE_REPLAY_REASON);
		assert.deepEqual(
			held.facts.filter((fact) => fact.type === MIGRATION_EVENTS.RolledBack),
			[],
		);
		const last = held.facts[held.facts.length - 1];
		assert.equal(last?.type, MIGRATION_EVENTS.Held);

		let replayed = 0;
		const rolled = await runInPlaceEvolve(
			options(store, journal, {
				plan: failing,
				replayErasures: () => {
					replayed += 1;
					return 4;
				},
			}),
		);
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(store.restored, ["snap-1"]);
		assert.equal(replayed, 1);
		const fact = rolled.facts.find(
			(entry) => entry.type === MIGRATION_EVENTS.RolledBack,
		);
		assert.equal(fact?.data.erasuresReplayed, 4);
		assert.equal(fact?.data.snapshotRef, "snap-1");
	});
});

describe("in-place-evolve verification and compatibility evidence", () => {
	test("a throwing contract verification restores the snapshot and does not expose the error", async () => {
		const store = new FakeStore();
		const verify = store.verify.bind(store);
		store.verify = (query = "") => {
			if (query === PLAN.verify.afterContract)
				throw new Error("private database connection string");
			return verify(query);
		};
		const result = await runInPlaceEvolve(
			options(store, createMemoryMigrationJournal()),
		);
		assert.equal(result.status, "rolled-back");
		assert.deepEqual(store.restored, ["snap-1"]);
		assert.deepEqual(store.applied, []);
		assert.match(
			result.blockedReasons[0] ?? "",
			/^contract verification failed: Error$/u,
		);
		assert.doesNotMatch(JSON.stringify(result), /private database/u);
		assert.ok(
			result.facts.some(
				(fact) => fact.type === MIGRATION_EVENTS.RollbackDecided,
			),
		);
		assert.equal(result.facts.at(-1)?.type, MIGRATION_EVENTS.RolledBack);
	});

	test("a failed verification holds without erasure replay and restores after replay is supplied", async () => {
		const store = new FakeStore();
		const verify = store.verify.bind(store);
		store.verify = (query = "") => {
			if (query === PLAN.verify.afterContract) throw new Error("unavailable");
			return verify(query);
		};
		const journal = createMemoryMigrationJournal();
		const { replayErasures: _unwired, ...bare } = options(store, journal);
		const held = await runInPlaceEvolve(bare);
		assert.equal(held.status, "held");
		assert.deepEqual(store.restored, []);
		assert.ok(held.blockedReasons.includes(NO_ERASURE_REPLAY_REASON));
		const rolled = await runInPlaceEvolve(options(store, journal));
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(store.restored, ["snap-1"]);
	});

	test("a gate exception holds before contract without exposing the error or restoring", async () => {
		const store = new FakeStore();
		const result = await runInPlaceEvolve(
			options(store, createMemoryMigrationJournal(), {
				compatGate: () => {
					throw new Error("private credential");
				},
			}),
		);
		assert.equal(result.status, "held");
		assert.equal(result.dualWindowOpen, true);
		assert.deepEqual(store.restored, []);
		assert.ok(!store.calls.includes("apply:contract"));
		assert.doesNotMatch(JSON.stringify(result), /private credential/u);
	});

	test("rejects stale, future, and malformed compatibility evidence before contract", async () => {
		const at = Date.parse(NOW);
		for (const verifiedAt of [
			new Date(at - 300_001).toISOString(),
			new Date(at + 1).toISOString(),
			"invalid",
		]) {
			const store = new FakeStore();
			const result = await runInPlaceEvolve(
				options(store, createMemoryMigrationJournal(), {
					compatGate: () => ({
						gateId: "g",
						consumersOnLegacySchema: [],
						verifiedAt,
					}),
				}),
			);
			assert.equal(result.status, "contract-blocked");
			assert.equal(result.dualWindowOpen, true);
			assert.ok(!store.calls.includes("apply:contract"));
		}
	});

	test("rechecks backfill after a stale gate without restoring over intervening writes", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		let verifiedAt = new Date(Date.parse(NOW) - 300_001).toISOString();
		const run = () =>
			runInPlaceEvolve(
				options(store, journal, {
					compatGate: () => ({
						gateId: "g",
						consumersOnLegacySchema: [],
						verifiedAt,
					}),
				}),
			);
		assert.equal((await run()).status, "contract-blocked");
		verifiedAt = NOW;
		store.violations = [{ id: "new-write" }];
		const held = await run();
		assert.equal(held.status, "held");
		assert.deepEqual(store.restored, []);
		assert.ok(!store.calls.includes("apply:contract"));
		store.violations = [];
		assert.equal((await run()).status, "completed");
	});

	test("validates the configured maximum age before taking a snapshot", async () => {
		for (const compatGateMaxAgeMs of [
			0,
			-1,
			Number.POSITIVE_INFINITY,
			Number.NaN,
		]) {
			const store = new FakeStore();
			await assert.rejects(
				runInPlaceEvolve(options(store, undefined, { compatGateMaxAgeMs })),
				/positive and finite/u,
			);
			assert.deepEqual(store.calls, []);
		}
	});

	test("enforces a caller's shorter compatibility evidence lifetime", async () => {
		const store = new FakeStore();
		const result = await runInPlaceEvolve(
			options(store, undefined, {
				compatGateMaxAgeMs: 1_000,
				compatGate: () => ({
					gateId: "g",
					consumersOnLegacySchema: [],
					verifiedAt: new Date(Date.parse(NOW) - 1_001).toISOString(),
				}),
			}),
		);
		assert.equal(result.status, "contract-blocked");
		assert.ok(!store.calls.includes("apply:contract"));
	});

	test("checks evidence freshness after the contract policy finishes", async () => {
		const store = new FakeStore();
		let now = NOW;
		const result = await runInPlaceEvolve(
			options(store, undefined, {
				clock: () => now,
				policy: (phase) => {
					if (phase === "contract")
						now = new Date(Date.parse(NOW) + 300_001).toISOString();
					return allow;
				},
			}),
		);
		assert.equal(result.status, "contract-blocked");
		assert.ok(!store.calls.includes("apply:contract"));
	});

	test("verifies backfill after the contract policy and gate have returned", async () => {
		const store = new FakeStore();
		const result = await runInPlaceEvolve(
			options(store, undefined, {
				compatGate: () => {
					store.violations = [{ id: "changed-during-gate" }];
					return { gateId: "g", consumersOnLegacySchema: [], verifiedAt: NOW };
				},
			}),
		);
		assert.equal(result.status, "rolled-back");
		assert.ok(!store.calls.includes("apply:contract"));
	});
});

describe("in-place-evolve records no thrown message", () => {
	const SECRETS = /hunter2|postgres:\/\/|dsn=|duplicate column|db\.internal/u;

	test("a failed phase: the fact and the result name the error's class, never its message", async () => {
		for (const plan of [
			{ ...PLAN, expand: ["FAIL expand"] },
			{ ...PLAN, backfill: ["FAIL backfill"] },
			{ ...PLAN, contract: ["FAIL contract"] },
		]) {
			const result = await runInPlaceEvolve(
				options(new FakeStore(), createMemoryMigrationJournal(), { plan }),
			);
			assert.equal(result.status, "rolled-back");
			assert.doesNotMatch(JSON.stringify(result), SECRETS);
			assert.match(result.blockedReasons[0] ?? "", /failed: Error$/u);
		}
	});

	test("a failed restore: migration.Failed carries the class name, and this package's own errors their code", async () => {
		const store = new FakeStore();
		store.restore = () => {
			throw new Error(
				"cannot open postgres://app:hunter2@db.internal/prod: connection refused",
			);
		};
		const failed = await runInPlaceEvolve(
			options(store, createMemoryMigrationJournal(), {
				plan: { ...PLAN, backfill: ["FAIL backfill"] },
			}),
		);
		assert.equal(failed.status, "failed");
		assert.doesNotMatch(JSON.stringify(failed), SECRETS);
		const fact = failed.facts.find(
			(entry) => entry.type === MIGRATION_EVENTS.Failed,
		);
		assert.equal(
			fact?.data.reason,
			"restore failed after phase execution failed: Error: Error",
		);

		const coded = new FakeStore();
		coded.restore = () => {
			throw new DataCoreError("RETIRE_REFUSED", "secret hunter2 in a message");
		};
		const result = await runInPlaceEvolve(
			options(coded, createMemoryMigrationJournal(), {
				plan: { ...PLAN, backfill: ["FAIL backfill"] },
			}),
		);
		assert.doesNotMatch(JSON.stringify(result), SECRETS);
		assert.match(
			String(
				result.facts.find((entry) => entry.type === MIGRATION_EVENTS.Failed)
					?.data.reason,
			),
			/DataCoreError: RETIRE_REFUSED$/u,
		);
	});

	test("a restore that failed is finished by the next run", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		const real = store.restore.bind(store);
		let broken = true;
		store.restore = (ref) => {
			if (broken) throw new Error("storage unavailable");
			real(ref);
		};
		const plan = { ...PLAN, backfill: ["FAIL backfill"] };
		const failed = await runInPlaceEvolve(options(store, journal, { plan }));
		assert.equal(failed.status, "failed");
		broken = false;
		const rolled = await runInPlaceEvolve(options(store, journal, { plan }));
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(store.restored, ["snap-1"]);
		assert.deepEqual(store.applied, []);
	});
});

describe("in-place-evolve custody coverage", () => {
	test("a positive verdict that names neither the store nor its rollback snapshot holds before anything is touched", async () => {
		const store = new FakeStore();
		const held = await runInPlaceEvolve(
			options(store, createMemoryMigrationJournal(), {
				policy: () => ({ ok: true, findings: [], roles: ["source"] }),
			}),
		);
		assert.equal(held.status, "held");
		assert.match(held.blockedReasons[0] ?? "", /CUSTODY_PATH_INCOMPLETE/u);
		assert.match(held.blockedReasons[0] ?? "", /rollback-snapshot/u);
		assert.deepEqual(store.calls, []);
	});
});

describe("in-place-evolve does not guess about a phase it cannot account for", () => {
	function dying(
		type: string,
		phase: SchemaPhase,
		when: "before" | "after",
	): MigrationJournal {
		const inner = createMemoryMigrationJournal();
		let armed = true;
		return {
			load: (id) => inner.load(id),
			async append(id, fact, expectedCount) {
				const hit = armed && fact.type === type && fact.data.phase === phase;
				if (hit && when === "before") {
					armed = false;
					throw new Error("the process died");
				}
				await inner.append(id, fact, expectedCount);
				if (hit) {
					armed = false;
					throw new Error("the process died");
				}
			},
		};
	}

	const probed = { ...PLAN, probes: PROBES };

	for (const phase of ["expand", "backfill", "contract"] as const) {
		test(`${phase} committed and its fact was never written: the resumed run holds, and restores nothing — with erasure replay wired or not`, async () => {
			const store = new FakeStore();
			const journal = dying(MIGRATION_EVENTS.PhaseApplied, phase, "before");
			await assert.rejects(
				runInPlaceEvolve(options(store, journal)),
				/the process died/u,
			);
			const applied = [...store.applied];
			const calls = store.calls.length;
			for (const run of [1, 2]) {
				const held = await runInPlaceEvolve(options(store, journal));
				assert.equal(held.status, "held", `run ${run}`);
				assert.match(
					held.blockedReasons[0] ?? "",
					new RegExp(`^${PHASE_OUTCOME_UNKNOWN}: .* the ${phase} phase`, "u"),
				);
				assert.deepEqual(store.restored, [], "the snapshot was restored");
				assert.deepEqual(store.applied, applied, "the store was changed");
				assert.equal(store.calls.length, calls, "the port was called again");
				assert.deepEqual(
					held.facts.filter(
						(fact) =>
							fact.type === MIGRATION_EVENTS.RollbackDecided ||
							fact.type === MIGRATION_EVENTS.RolledBack,
					),
					[],
				);
			}
			const done = await runInPlaceEvolve(
				options(store, journal, { plan: probed }),
			);
			assert.equal(done.status, "completed", done.blockedReasons.join("; "));
			assert.equal(
				store.calls.filter((call) => call === `apply:${phase}`).length,
				1,
				"the phase ran twice",
			);
			assert.deepEqual(store.restored, []);
			const fact = done.facts.find(
				(entry) =>
					entry.type === MIGRATION_EVENTS.PhaseApplied &&
					entry.data.phase === phase,
			);
			assert.equal(fact?.data.recovered, true);
			assert.deepEqual(store.applied, [
				"ADD email_new",
				"FILL email_new",
				"DROP email",
			]);
		});
	}

	test("the intent was journaled and the statements never ran: the probe says so, and the phase is applied under a fresh intent", async () => {
		const store = new FakeStore();
		const journal = dying(MIGRATION_EVENTS.PhaseIntended, "contract", "after");
		await assert.rejects(
			runInPlaceEvolve(options(store, journal, { plan: probed })),
			/the process died/u,
		);
		assert.deepEqual(store.applied, ["ADD email_new", "FILL email_new"]);
		const done = await runInPlaceEvolve(
			options(store, journal, { plan: probed }),
		);
		assert.equal(done.status, "completed", done.blockedReasons.join("; "));
		assert.deepEqual(store.applied, [
			"ADD email_new",
			"FILL email_new",
			"DROP email",
		]);
		const intents = done.facts.filter(
			(fact) =>
				fact.type === MIGRATION_EVENTS.PhaseIntended &&
				fact.data.phase === "contract",
		);
		assert.deepEqual(
			intents.map((fact) => fact.data.retry),
			[undefined, true],
		);
	});

	test("a phase applied again after an unanswered intent, and failing, is never answered by a restore", async () => {
		const store = new FakeStore();
		const journal = dying(MIGRATION_EVENTS.PhaseIntended, "contract", "after");
		await assert.rejects(
			runInPlaceEvolve(options(store, journal, { plan: probed })),
			/the process died/u,
		);
		const failing = {
			...probed,
			contract: ["FAIL contract"],
			probes: { ...PROBES, contract: "PENDING FAIL contract" },
		};
		for (const run of [1, 2]) {
			const held = await runInPlaceEvolve(
				options(store, journal, { plan: failing }),
			);
			assert.equal(held.status, "held", `run ${run}`);
			assert.match(
				held.blockedReasons[0] ?? "",
				new RegExp(
					`^${PHASE_REAPPLY_FAILED}: .*: Error\\. Nothing was restored$`,
					"u",
				),
			);
			assert.deepEqual(store.restored, [], "the snapshot was restored");
			assert.doesNotMatch(JSON.stringify(held), /hunter2|dsn=/u);
		}
		assert.deepEqual(store.applied, ["ADD email_new", "FILL email_new"]);
	});

	test("a failure the port reports is an answer: the phase is not in effect, and the next run may restore as before", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		const failing = { ...PLAN, contract: ["FAIL contract"] };
		const { replayErasures: _unwired, ...bare } = options(store, journal, {
			plan: failing,
		});
		const held = await runInPlaceEvolve(bare);
		assert.equal(held.status, "held");
		const last = held.facts[held.facts.length - 1];
		assert.equal(last?.data.failedPhase, "contract");
		const rolled = await runInPlaceEvolve(
			options(store, journal, { plan: failing }),
		);
		assert.equal(rolled.status, "rolled-back");
		assert.deepEqual(store.restored, ["snap-1"]);
	});

	test("an apply that threw although the phase committed — the answer was lost, not the phase — is recorded as applied when the probe says so", async () => {
		const store = new FakeStore();
		const journal = createMemoryMigrationJournal();
		const real = store.applyPhase.bind(store);
		const lossy: SchemaApplyPort = {
			snapshot: () => store.snapshot(),
			verify: (query) => store.verify(query),
			restore: (ref) => store.restore(ref),
			applyPhase: (phase, statements) => {
				const result = real(phase, statements);
				if (phase === "contract") {
					throw new Error("connection reset after COMMIT");
				}
				return result;
			},
		};
		const done = await runInPlaceEvolve(
			options(lossy, journal, { plan: probed }),
		);
		assert.equal(done.status, "completed", done.blockedReasons.join("; "));
		assert.deepEqual(store.restored, [], "a committed phase was restored away");
		assert.deepEqual(store.applied, [
			"ADD email_new",
			"FILL email_new",
			"DROP email",
		]);
	});
});
