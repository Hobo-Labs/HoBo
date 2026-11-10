// The `migration.*` bodies the executors emit, held to the pinned contracts.
//
// Every `@hobo/data-core` executor is run against the reference engine —
// through to completion, into holds, compensations, rollbacks and failures,
// for both realizations — with its facts journaled on the real event store.
// Each stored event is then validated against the current version of its
// contract in `MIGRATION_EVENT_CONTRACTS`, at the version the journal stamped
// on it. An executor that grows a field, or a contract that loses one, fails
// here rather than in whoever reads the journal next.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ChangeEnvelope,
	type CopyMigrationOptions,
	CUSTODY_ROLES,
	createEventStoreMigrationJournal,
	createReferenceEngine,
	createReferenceNativeLink,
	type DatasetSchema,
	deleteMutation,
	type EngineBinding,
	encodeRecordKey,
	evaluateCustodyPath,
	fenceTokenDigest,
	foldMigration,
	liftMigrationFacts,
	MIGRATION_EVENTS,
	MIGRATION_FACT_VERSIONS,
	type MigrationFact,
	type MigrationJournal,
	type MigrationRuntime,
	migrationFactVersion,
	type PivotEvent,
	type PolicyVerdict,
	type ProjectionFold,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	REFERENCE_NATIVE_PROFILE,
	type RecordMutation,
	runInPlaceEvolve,
	runLogPivot,
	runOfflineCopy,
	runRebuildAndSwap,
	runSnapshotAndTail,
	runStreamHandoff,
	type SchemaApplyPort,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, test } from "vitest";
import {
	decodeEventBody,
	type EventBody,
	encodeEventBody,
	runCanDeployUpcasterGate,
	validateEventBody,
} from "../src/upcaster.js";
import {
	currentMigrationEventSchema,
	MIGRATION_EVENT_CONTRACTS,
} from "../src/upcaster-corpus.js";

const NOW = "2026-11-10T00:00:00.000Z";
const ACTOR = { kind: "system" as const, id: "contract-test" };
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function eventStore(): RuntimeLocalEventStore {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-fact-contracts-"));
	const store = createRuntimeLocalEventStore({
		dataDir: dir,
		clock: createManualClock(),
	});
	cleanups.push(() => {
		store.close();
		rmSync(dir, { recursive: true, force: true });
	});
	return store;
}

const ORDERS: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "total", type: "decimal", nullable: false },
	],
});

const ALLOW: PolicyVerdict = evaluateCustodyPath({
	path: parseCustodyPath({
		points: CUSTODY_ROLES.map((role) => ({
			id: role,
			role,
			region: "eu-west-1",
			protections: [],
			...(role === "source" || role === "target" || role === "event-log"
				? undefined
				: { retainUntil: "2026-11-17T00:00:00.000Z" }),
		})),
	}),
	policy: { classification: "public" },
	now: NOW,
});

const DENY: PolicyVerdict = {
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

function order(id: string, total: string): RecordMutation {
	const record = parseCanonicalRecord(ORDERS, { id, total });
	return upsertMutation("", encodeRecordKey(ORDERS, record), record);
}

function keyOf(id: string): string {
	return encodeRecordKey(
		ORDERS,
		parseCanonicalRecord(ORDERS, { id, total: "0" }),
	);
}

/** One journal store per test; every migration in it is a stream of facts. */
interface Recorder {
	readonly store: RuntimeLocalEventStore;
	readonly journal: MigrationJournal;
	readonly migrations: string[];
	runtime(id: string, extra?: Partial<MigrationRuntime>): MigrationRuntime;
}

function recorder(): Recorder {
	const store = eventStore();
	const journal = createEventStoreMigrationJournal(store, {
		tenant: "acme",
		actor: ACTOR,
	});
	const migrations: string[] = [];
	return {
		store,
		journal,
		migrations,
		runtime(id, extra = {}) {
			if (!migrations.includes(id)) migrations.push(id);
			return {
				migrationId: id,
				journal,
				clock: () => NOW,
				policy: () => ALLOW,
				...extra,
			};
		},
	};
}

interface Seen {
	readonly types: Set<string>;
	count: number;
}

/**
 * Validate every stored fact of every migration the recorder ran: the body
 * against the current schema of its type, the stamped version against the
 * contract's current version, and the body through an encode/decode round
 * trip of the pinned wire form.
 */
async function assertEveryFactValid(from: Recorder, seen: Seen): Promise<void> {
	for (const id of from.migrations) {
		for await (const event of from.store.read(`migration:${id}`)) {
			const where = `${id} #${event.seq} ${event.type}`;
			const schema = currentMigrationEventSchema(event.type);
			assert.ok(schema, `${where}: no pinned contract for this type`);
			assert.equal(
				event.v,
				schema.version,
				`${where}: journaled at v${event.v}, the contract is at v${schema.version}`,
			);
			// SAFETY: a migration fact is a JSON object; the validator decides whether it is this body.
			const body = event.data as EventBody;
			const verdict = validateEventBody(schema, body);
			assert.deepEqual(verdict.errors, [], `${where}: ${JSON.stringify(body)}`);
			const wire = encodeEventBody(schema, body);
			assert.deepEqual(
				decodeEventBody(schema, wire),
				JSON.parse(JSON.stringify(body)),
				`${where}: the wire form does not round-trip`,
			);
			seen.types.add(event.type);
			seen.count += 1;
		}
	}
}

// ── stages ──────────────────────────────────────────────────────────────────

async function pair(
	realization: "hub" | "native",
	targetOmit: "capture"[] = [],
) {
	const link =
		realization === "native" ? createReferenceNativeLink() : undefined;
	const hubless = ["snapshot", "capture", "apply"] as const;
	const source = createReferenceEngine({
		engine: "reference",
		omit: link === undefined ? [] : [...hubless],
		...(link === undefined ? undefined : { native: link }),
	});
	const target = createReferenceEngine({
		engine: "reference",
		omit: [...(link === undefined ? [] : hubless), ...targetOmit],
		...(link === undefined ? undefined : { native: link }),
	});
	await source.datasets.ensureDataset(ORDERS);
	await source.records.write({
		dataset: "orders",
		mutations: [order("o-1", "1"), order("o-2", "2"), order("o-3", "3")],
	});
	return { realization, source, target };
}

function copy(
	staged: Awaited<ReturnType<typeof pair>>,
	runtime: MigrationRuntime,
	extra: Partial<CopyMigrationOptions> = {},
): CopyMigrationOptions {
	return {
		runtime,
		source: staged.source,
		target: staged.target,
		schema: ORDERS,
		scope: scopeOf("orders"),
		maxTailRounds: 4,
		buckets: 4,
		flipAuthority: () => {},
		shiftReads: () => {},
		...(staged.realization === "native"
			? { realization: "native", profile: REFERENCE_NATIVE_PROFILE }
			: undefined),
		...extra,
	};
}

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

const ordersFold: ProjectionFold = {
	name: "orders-projection",
	project(event): readonly RecordMutation[] {
		if (event.type !== "order.Recorded" && event.type !== "order.Removed") {
			return [];
		}
		// SAFETY: order events appended by this file carry these JSON bodies.
		const data = event.data as { id: string; total?: string };
		return event.type === "order.Recorded"
			? [order(data.id, data.total ?? "0")]
			: [deleteMutation("", keyOf(data.id))];
	},
};

async function placeOrders(
	log: RuntimeLocalEventStore,
	ids: readonly string[],
) {
	for (const id of ids) {
		await log.append(
			`order:${id}`,
			[{ type: "order.Recorded", data: { id, total: "1" } }],
			{ expectedSeq: 0, actor: ACTOR, tenant: "acme" },
		);
	}
}

/** A schema port that fails any statement beginning FAIL. */
function schemaPort(restoreFails = false): SchemaApplyPort {
	return {
		snapshot: () => ({ ref: "snap-1", takenAt: NOW }),
		applyPhase(phase, statements) {
			if (statements.some((statement) => statement.startsWith("FAIL"))) {
				throw new Error("statement failed [dsn=postgres://app:secret@db/prod]");
			}
			return { phase, statements: statements.length, changes: 3 };
		},
		verify: () => [],
		restore() {
			if (restoreFails) throw new Error("storage unavailable");
		},
	};
}

const PLAN = {
	migrationId: "evolve",
	expand: ["ADD"],
	backfill: ["FILL"],
	contract: ["DROP"],
	verify: { afterBackfill: "SELECT 1", afterContract: "SELECT 2" },
};
const gate = () => ({
	gateId: "g",
	consumersOnLegacySchema: [],
	verifiedAt: NOW,
});

describe("every fact an executor emits validates against its pinned contract", () => {
	const seen: Seen = { types: new Set(), count: 0 };

	for (const realization of ["hub", "native"] as const) {
		test(`snapshot-and-tail and offline-copy, ${realization}: completion, a pause, a policy hold, a compensation`, async () => {
			const record = recorder();
			for (const [name, run] of [
				["sat", runSnapshotAndTail],
				["offline", runOfflineCopy],
			] as const) {
				const done = await run(
					copy(await pair(realization), record.runtime(`${name}-done`)),
				);
				assert.equal(done.status, "completed", done.reason);
			}
			// Held by policy, between two phases, then resumed.
			const staged = await pair(realization);
			let allowed = false;
			const policy = (phase: string) =>
				phase === "verify" && !allowed ? DENY : ALLOW;
			const held = await runSnapshotAndTail(
				copy(staged, record.runtime("policy", { policy })),
			);
			assert.equal(held.status, "held");
			allowed = true;
			const resumed = await runSnapshotAndTail(
				copy(
					staged,
					record.runtime("policy", { policy, pauseAfter: "verify" }),
				),
			);
			assert.equal(resumed.status, "held");
			// A compensation: a record on the target the migration did not put
			// there fails verification under the fence.
			const compensated = await pair(realization);
			const stray = await runSnapshotAndTail(
				copy(
					compensated,
					record.runtime("compensated", {
						afterPhase: async (phase) => {
							if (phase !== "shift-reads") return;
							await compensated.target.records.write({
								dataset: "orders",
								mutations: [order("stray", "9")],
							});
						},
					}),
				),
			);
			assert.equal(stray.status, "held");
			await compensated.target.records.write({
				dataset: "orders",
				mutations: [deleteMutation("", keyOf("stray"))],
			});
			const recovered = await runSnapshotAndTail(
				copy(compensated, record.runtime("compensated")),
			);
			assert.equal(recovered.status, "completed", recovered.reason);
			await assertEveryFactValid(record, seen);
		});

		test(`rollbacks, ${realization}: to the stale source with erasures re-applied`, async () => {
			const record = recorder();
			const staged = await pair(
				realization,
				realization === "hub" ? ["capture"] : [],
			);
			const options = (decision: "hold" | "rollback") =>
				copy(staged, record.runtime("to-snapshot"), {
					soakDecision: () => decision,
					erasures: { since: () => [deleteMutation("", keyOf("o-2"))] },
				});
			assert.equal((await runSnapshotAndTail(options("hold"))).status, "held");
			const rolled = await runSnapshotAndTail(options("rollback"));
			assert.equal(rolled.status, "rolled-back");
			await assertEveryFactValid(record, seen);
		});
	}

	test("a lossless rollback, one that has not converged, and a failure", async () => {
		const record = recorder();
		const staged = await pair("hub");
		const options = (decision: "hold" | "rollback") =>
			copy(staged, record.runtime("lossless"), {
				soakDecision: () => decision,
			});
		assert.equal((await runSnapshotAndTail(options("hold"))).status, "held");
		await staged.target.records.write({
			dataset: "orders",
			mutations: [order("after-flip", "9")],
		});
		const rolled = await runSnapshotAndTail(options("rollback"));
		assert.equal(rolled.status, "rolled-back");

		// A run that throws: migration.Failed.
		const broken = await pair("hub");
		await assert.rejects(
			runSnapshotAndTail(
				copy(broken, record.runtime("failed"), {
					flipAuthority: () => {
						throw new Error("router unavailable");
					},
				}),
			),
			/router unavailable/u,
		);
		await assertEveryFactValid(record, seen);
	});

	test("rebuild-and-swap, log-pivot and stream-handoff", async () => {
		const record = recorder();
		const log = eventStore();
		await placeOrders(log, ["o-1", "o-2", "o-3"]);
		const previous = createReferenceEngine({ engine: "old-sink" });
		const rebuild = (
			id: string,
			target: EngineBinding,
			soak: "finalize" | "rollback",
		) =>
			runRebuildAndSwap({
				runtime: record.runtime(id),
				log,
				fold: ordersFold,
				target,
				schema: ORDERS,
				scope: scopeOf("orders"),
				soakDecision: () => soak,
			});
		// The old sink is built by the same fold, then compared against.
		assert.equal(
			(await rebuild("rebuild-first", previous, "finalize")).status,
			"completed",
		);
		const compared = await runRebuildAndSwap({
			runtime: record.runtime("rebuild-compared"),
			log,
			fold: { ...ordersFold, name: "orders-projection-v2" },
			target: createReferenceEngine({ engine: "new-sink" }),
			previous,
			schema: ORDERS,
			scope: scopeOf("orders"),
		});
		assert.equal(compared.status, "completed", compared.reason);
		const swappedBack = await rebuild(
			"rebuild-rollback",
			createReferenceEngine({ engine: "other-sink" }),
			"rollback",
		);
		assert.equal(swappedBack.status, "rolled-back");

		const adopted = await pair("hub");
		const pivotLog = eventStore();
		let allowed = false;
		const pivot = () =>
			runLogPivot({
				runtime: record.runtime("pivot", {
					policy: (phase) => (phase === "finalize" && !allowed ? DENY : ALLOW),
				}),
				source: adopted.source,
				schema: ORDERS,
				scope: scopeOf("orders"),
				log: pivotLog,
				toEvents,
				append: { actor: ACTOR, tenant: "acme" },
				fold: ordersFold,
				target: adopted.target,
				targetSchema: ORDERS,
				targetScope: scopeOf("orders"),
				flipAuthority: () => {},
			});
		// Held after the flip, before finalize — then completed.
		assert.equal((await pivot()).status, "held");
		allowed = true;
		assert.equal((await pivot()).status, "completed");

		const target = eventStore();
		const handoff = await runStreamHandoff({
			runtime: record.runtime("handoff"),
			source: log,
			target,
			quiesce: () => ({ fenceToken: "owner-epoch-2" }),
			unquiesce: () => {},
			flipWriter: () => {},
		});
		assert.equal(handoff.status, "completed", handoff.reason);
		await assertEveryFactValid(record, seen);
	});

	test("in-place-evolve: completion, a hold and its resume, a rollback, a failed restore, and a hold for want of an erasure replay", async () => {
		const record = recorder();
		const run = (
			id: string,
			extra: Partial<Parameters<typeof runInPlaceEvolve>[0]> = {},
		) => {
			if (!record.migrations.includes(id)) record.migrations.push(id);
			return runInPlaceEvolve({
				port: schemaPort(),
				plan: { ...PLAN, migrationId: id },
				compatGate: gate,
				clock: () => NOW,
				journal: record.journal,
				replayErasures: () => 2,
				...extra,
			});
		};
		assert.equal((await run("evolve-done")).status, "completed");
		let allowed = false;
		const policy = () => ({
			ok: allowed,
			findings: allowed ? [] : [{ code: "CUSTODY_RETENTION_EXPIRED" }],
			roles: ["source", "rollback-snapshot"],
		});
		assert.equal((await run("evolve-held", { policy })).status, "held");
		allowed = true;
		assert.equal((await run("evolve-held", { policy })).status, "completed");
		const failing = { ...PLAN, backfill: ["FAIL"] };
		assert.equal(
			(
				await run("evolve-rolled", {
					plan: { ...failing, migrationId: "evolve-rolled" },
				})
			).status,
			"rolled-back",
		);
		assert.equal(
			(
				await run("evolve-failed", {
					plan: { ...failing, migrationId: "evolve-failed" },
					port: schemaPort(true),
				})
			).status,
			"failed",
		);
		const { replayErasures: _unwired, ...bare } = {
			port: schemaPort(),
			plan: { ...failing, migrationId: "evolve-no-ledger" },
			compatGate: gate,
			clock: () => NOW,
			journal: record.journal,
			replayErasures: undefined,
		};
		record.migrations.push("evolve-no-ledger");
		assert.equal((await runInPlaceEvolve(bare)).status, "held");
		await assertEveryFactValid(record, seen);
	});

	test("between them the runs above emitted every fact type the executors can", () => {
		// Exported and Imported belong to the tenant export path, not to an
		// executor; every other type must have been seen, or this file proves
		// less than it says.
		const emitted = Object.values(MIGRATION_EVENTS).filter(
			(type) =>
				type !== MIGRATION_EVENTS.Exported &&
				type !== MIGRATION_EVENTS.Imported,
		);
		assert.deepEqual(
			emitted.filter((type) => !seen.types.has(type)),
			[],
			"fact types no scenario produced",
		);
		assert.ok(seen.count > 150, `only ${seen.count} facts were checked`);
	});
});

describe("the two packages agree on what they cannot import from each other", () => {
	test("every fact type has a contract, and the version the journal stamps is the contract's current one", () => {
		for (const type of Object.values(MIGRATION_EVENTS)) {
			const contract = MIGRATION_EVENT_CONTRACTS.find(
				(entry) => entry.type === type,
			);
			assert.ok(contract, `no pinned contract for ${type}`);
			assert.equal(
				migrationFactVersion(type),
				contract.currentVersion,
				`${type}: data-core stamps v${migrationFactVersion(type)}`,
			);
		}
		for (const type of Object.keys(MIGRATION_FACT_VERSIONS)) {
			assert.ok(
				currentMigrationEventSchema(type),
				`data-core versions ${type}, which has no contract`,
			);
		}
		for (const contract of MIGRATION_EVENT_CONTRACTS) {
			assert.ok(
				Object.values<string>(MIGRATION_EVENTS).includes(contract.type),
				`${contract.type} is pinned and data-core does not know it`,
			);
		}
	});

	test("the CutOver upcaster's digest of a fence token is the digest the executors journal", () => {
		const contract = MIGRATION_EVENT_CONTRACTS.find(
			(entry) => entry.type === MIGRATION_EVENTS.CutOver,
		);
		assert.ok(contract);
		const report = runCanDeployUpcasterGate(contract);
		assert.deepEqual(report.errors, []);
		const lifted = report.replays.find((replay) =>
			replay.key.endsWith("#migration-CutOver-v1-fence-token"),
		);
		assert.ok(lifted);
		assert.equal(lifted.sourceVersion, 1);
		assert.equal(lifted.currentVersion, 2);
		// The credential is gone from the lifted body; its digest took its place.
		assert.ok(!("fenceToken" in lifted.currentBody));
		assert.equal(
			lifted.currentBody.fenceTokenDigest,
			fenceTokenDigest("fence:orders::1"),
		);
		assert.ok(!JSON.stringify(lifted.currentBody).includes("fence:orders::1"));
	});
});

// A journal outlives the code that wrote it. `fixtures/journal-65a46a72.json`
// is what the executors at 65a46a72 appended — every body at v1 — recorded
// once and never edited. Each body must be a valid v1 body, lift through the
// pinned upcasters to a valid current one, and come out exactly as
// `@hobo/data-core` lifts it when it loads the journal.
interface RecordedJournal {
	readonly facts: readonly MigrationFact[];
}

interface RecordedJournals {
	readonly snapshotAndTail: RecordedJournal;
	readonly inPlaceEvolve: RecordedJournal;
}

// SAFETY: the committed fixture has this layout; every body in it is validated against its v1 contract below.
const RECORDED = JSON.parse(
	readFileSync(
		path.join(import.meta.dirname, "fixtures", "journal-65a46a72.json"),
		"utf8",
	),
) as RecordedJournals;

function liftThroughContracts(fact: MigrationFact): MigrationFact {
	const contract = MIGRATION_EVENT_CONTRACTS.find(
		(entry) => entry.type === fact.type,
	);
	assert.ok(contract, `no pinned contract for ${fact.type}`);
	const schemaAt = (version: number) => {
		const schema = contract.schemas.find((entry) => entry.version === version);
		assert.ok(schema, `${fact.type} has no v${version}`);
		return schema;
	};
	// SAFETY: a fact body is a JSON object, which is what an event body is.
	let body = fact.data as EventBody;
	assert.deepEqual(
		validateEventBody(schemaAt(1), body).errors,
		[],
		`${fact.type}: what 65a46a72 wrote is not a valid v1 body`,
	);
	for (let version = 1; version < contract.currentVersion; version += 1) {
		const upcaster = contract.upcasters.find((entry) => entry.from === version);
		assert.ok(upcaster, `${fact.type} has no upcaster from v${version}`);
		body = upcaster.upcast(body);
		assert.deepEqual(
			validateEventBody(schemaAt(upcaster.to), body).errors,
			[],
			`${fact.type}: the upcaster produced an invalid v${upcaster.to} body`,
		);
	}
	// SAFETY: an upcast event body is a JSON object, which is what a fact carries.
	return { type: fact.type, data: body as MigrationFact["data"] };
}

describe("a journal recorded from the 65a46a72 executors", () => {
	const recorded = [
		...RECORDED.snapshotAndTail.facts,
		...RECORDED.inPlaceEvolve.facts,
	];

	test("every recorded body is a valid v1 body and lifts to a valid current one", () => {
		assert.ok(recorded.length >= 15, "the fixture is the two recorded runs");
		for (const fact of recorded) liftThroughContracts(fact);
	});

	test("the lifted plan keeps its pattern and its digests; an in-place plan, which named no pattern, is named one", () => {
		const [planned] = RECORDED.snapshotAndTail.facts;
		assert.ok(planned);
		const lifted = liftThroughContracts(planned).data;
		assert.equal(lifted.pattern, "snapshot-and-tail");
		assert.equal(lifted.decisionDigest, planned.data.decisionDigest);
		assert.equal(lifted.custodyDigest, planned.data.custodyDigest);
		assert.deepEqual(lifted.phases, planned.data.phases);
		assert.deepEqual(
			[lifted.source, lifted.target, lifted.dataset],
			["src", "tgt", "orders"],
		);
		const [inPlace] = RECORDED.inPlaceEvolve.facts;
		assert.ok(inPlace);
		assert.equal(inPlace.data.pattern, undefined);
		assert.equal(liftThroughContracts(inPlace).data.pattern, "in-place-evolve");
	});

	test("no fence token survives the lift: the cutover and the fence-and-flip checkpoint carry its digest", () => {
		const cutOver = RECORDED.snapshotAndTail.facts.find(
			(fact) => fact.type === MIGRATION_EVENTS.CutOver,
		);
		const token = String(cutOver?.data.fenceToken);
		assert.equal(token, "fence:orders::1");
		// It is there twice in what was written: the reviewer's point.
		assert.equal(
			JSON.stringify(RECORDED.snapshotAndTail.facts).split(token).length - 1,
			2,
		);
		const lifted = RECORDED.snapshotAndTail.facts.map((fact) =>
			liftThroughContracts(fact),
		);
		assert.ok(!JSON.stringify(lifted).includes(token));
		const checkpoint = lifted.find(
			(fact) =>
				fact.type === MIGRATION_EVENTS.PhaseApplied &&
				fact.data.phase === "fence-and-flip",
		)?.data.checkpoint;
		assert.deepEqual(
			[
				lifted.find((fact) => fact.type === MIGRATION_EVENTS.CutOver)?.data
					.fenceTokenDigest,
				Object(checkpoint).fenceTokenDigest,
			],
			[fenceTokenDigest(token), fenceTokenDigest(token)],
		);
	});

	test("data-core lifts a loaded journal to exactly what the pinned upcasters produce, and folds it to the pattern it was planned as", () => {
		for (const journal of [RECORDED.snapshotAndTail, RECORDED.inPlaceEvolve]) {
			assert.deepEqual(
				liftMigrationFacts(journal.facts),
				journal.facts.map((fact) => liftThroughContracts(fact)),
			);
		}
		assert.equal(
			foldMigration("m", liftMigrationFacts(RECORDED.snapshotAndTail.facts))
				.pattern,
			"snapshot-and-tail",
		);
		assert.equal(
			foldMigration("evolve", liftMigrationFacts(RECORDED.inPlaceEvolve.facts))
				.pattern,
			"in-place-evolve",
		);
		// Lifting is idempotent: a lifted journal lifts to itself.
		const once = liftMigrationFacts(RECORDED.snapshotAndTail.facts);
		assert.deepEqual(liftMigrationFacts(once), once);
	});
});
