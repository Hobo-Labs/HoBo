/**
 * Migration facts and the migration aggregate (ADR-0177 decision 7).
 *
 * A migration is event-sourced like everything else: an executor emits
 * `migration.*` facts, the aggregate state is a fold over them, and resuming
 * after a crash or a hold is replaying that fold and continuing from the last
 * completed phase. Facts carry positions, counts, and digests — never a
 * record, never a credential.
 *
 * No new event family. The existing `migration.*` family gains `Held`,
 * `Resumed`, and `Completed`, and `PhaseApplied` carries the phase names of
 * the uniform phase model alongside the original expand/backfill/contract.
 *
 * Three facts are written *ahead* of what they describe. `FenceRequested` is
 * appended before a write fence is raised, `PhaseIntended` before an in-place
 * phase runs its statements, and `RollbackDecided` before write authority is
 * handed back — as `CutOver` is appended before it is handed over. Every
 * append is a compare-and-set on the head the run read, so a driver whose view
 * of the migration is out of date loses the append and stops before it touches
 * a store.
 *
 * `FenceRaised` follows a raise and records the digest of the token it
 * answered. That digest is how a later run proves a fence it finds standing is
 * this migration's own before it writes through it, adopts it or releases it.
 */
import {
	type EventStore,
	isEventStoreOptimisticConflict,
	type PrincipalRef,
} from "@hobo/core";
import { DataCoreError, JournalConflictError } from "./errors.js";
import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
	sha256Hex,
} from "./json.js";
import {
	isMigrationPatternId,
	isSafeHold,
	MIGRATION_PHASES,
	type MigrationPatternId,
	type MigrationPhase,
} from "./patterns.js";
import type { Awaitable } from "./spi.js";

export const MIGRATION_EVENTS = Object.freeze({
	Planned: "migration.Planned",
	SnapshotTaken: "migration.SnapshotTaken",
	PhaseApplied: "migration.PhaseApplied",
	Verified: "migration.Verified",
	CutOver: "migration.CutOver",
	RolledBack: "migration.RolledBack",
	Failed: "migration.Failed",
	Exported: "migration.Exported",
	Imported: "migration.Imported",
	Held: "migration.Held",
	Resumed: "migration.Resumed",
	Completed: "migration.Completed",
	FenceRequested: "migration.FenceRequested",
	RollbackDecided: "migration.RollbackDecided",
	FenceRaised: "migration.FenceRaised",
	PhaseIntended: "migration.PhaseIntended",
} as const);

export type MigrationEventType =
	(typeof MIGRATION_EVENTS)[keyof typeof MIGRATION_EVENTS];

// domain-view: in-process fact; each `data` body's wire form is the matching Migration*EventData message in data-models/data_core.proto.
export interface MigrationFact {
	readonly type: string;
	readonly data: JsonObject;
}

/**
 * The version each fact body is at. A durable journal stamps it on the event,
 * so a reader lifting an old stream knows which upcasters to run. The pinned
 * contracts live in `@hobo/events` (`MIGRATION_EVENT_CONTRACTS`); a test there
 * holds this table and the bodies the executors emit to them.
 */
export const MIGRATION_FACT_VERSIONS: Readonly<Record<string, number>> =
	Object.freeze({
		[MIGRATION_EVENTS.Planned]: 2,
		[MIGRATION_EVENTS.PhaseApplied]: 2,
		[MIGRATION_EVENTS.CutOver]: 2,
		[MIGRATION_EVENTS.RolledBack]: 2,
	});

/** The body version a fact of this type is appended at; 1 unless listed. */
export function migrationFactVersion(type: string): number {
	return MIGRATION_FACT_VERSIONS[type] ?? 1;
}

/**
 * What a journal records of a fence token. A fence token is a write-authority
 * credential: whoever presents it writes through the fence. A journal is
 * evidence, read by people and systems that must not gain that authority, so
 * it carries only this digest — enough for a resumed run to recognise the
 * fence a decision was made under, not enough to write through it.
 */
export function fenceTokenDigest(fenceToken: string): string {
	return `sha256:${sha256Hex(fenceToken)}`;
}

/** The phase names an in-place migration plans; no other pattern uses them. */
const IN_PLACE_PLAN_PHASES: readonly string[] = Object.freeze([
	"expand",
	"backfill",
	"contract",
]);

/** A body with its fence token replaced by the token's digest. */
function withoutFenceToken(body: JsonObject): JsonObject | undefined {
	const { fenceToken, ...kept } = body;
	if (!isJsonString(fenceToken)) return undefined;
	// The token is what was written; a digest beside it is derived from it.
	return { ...kept, fenceTokenDigest: fenceTokenDigest(fenceToken) };
}

/**
 * Lift one fact to the body its type is written at today. Journals outlive
 * the code that wrote them, so every run lifts what it loads before it folds:
 *
 * - `Planned` without a `pattern` whose phases are expand, backfill and
 *   contract was written by the in-place executor before it named its
 *   pattern; it is `in-place-evolve`. (A v1 body pinned `phases` as one
 *   comma-joined string; that is read as the list it stood for.)
 * - `CutOver` and `PhaseApplied`'s checkpoint once carried the fence token
 *   itself. The token is a credential: it is replaced by its digest, so it
 *   never reaches a fold, a result or a re-appended journal.
 *
 * Idempotent, and the identity for a body already at its current version. It
 * mirrors the upcasters pinned in `@hobo/events`; a test there holds the two
 * together over a recorded old journal.
 */
export function liftMigrationFact(fact: MigrationFact): MigrationFact {
	const { type, data } = fact;
	if (type === MIGRATION_EVENTS.Planned) {
		const phases = isJsonString(data.phases)
			? data.phases.split(",")
			: data.phases;
		const inPlace =
			data.pattern === undefined &&
			isJsonArray(phases) &&
			phases.length === IN_PLACE_PLAN_PHASES.length &&
			phases.every((phase, index) => phase === IN_PLACE_PLAN_PHASES[index]);
		if (!inPlace && phases === data.phases) return fact;
		return Object.freeze({
			type,
			data: Object.freeze({
				...data,
				...(phases === undefined ? undefined : { phases }),
				...(inPlace ? { pattern: "in-place-evolve" } : undefined),
			}),
		});
	}
	if (type === MIGRATION_EVENTS.CutOver) {
		const lifted = withoutFenceToken(data);
		return lifted === undefined
			? fact
			: Object.freeze({ type, data: Object.freeze(lifted) });
	}
	if (type === MIGRATION_EVENTS.PhaseApplied) {
		const checkpoint = data.checkpoint;
		const lifted = isJsonObject(checkpoint)
			? withoutFenceToken(checkpoint)
			: undefined;
		return lifted === undefined
			? fact
			: Object.freeze({
					type,
					data: Object.freeze({ ...data, checkpoint: lifted }),
				});
	}
	return fact;
}

/** `liftMigrationFact` over a loaded journal; one fact in, one fact out. */
export function liftMigrationFacts(
	facts: readonly MigrationFact[],
): readonly MigrationFact[] {
	return Object.freeze(facts.map((fact) => liftMigrationFact(fact)));
}

/** Which store a write fence is requested on. */
export const FENCE_SIDES = ["source", "target"] as const;
export type FenceSide = (typeof FENCE_SIDES)[number];

export const MIGRATION_REALIZATIONS = ["native", "hub"] as const;
/** `native` is an engine's own fast path; `hub` is the canonical envelope. */
export type MigrationRealization = (typeof MIGRATION_REALIZATIONS)[number];

function isRealization(
	value: JsonValue | undefined,
): value is MigrationRealization {
	return (
		isJsonString(value) &&
		// SAFETY: membership test against the closed tuple of realizations.
		(MIGRATION_REALIZATIONS as readonly string[]).includes(value)
	);
}

export const MIGRATION_STATUSES = [
	"new",
	"running",
	"held",
	"completed",
	"rolled-back",
	"failed",
] as const;
export type MigrationStatus = (typeof MIGRATION_STATUSES)[number];

// domain-view: folded aggregate state; wire form is MigrationState in data-models/data_core.proto.
export interface MigrationState {
	readonly migrationId: string;
	readonly status: MigrationStatus;
	readonly pattern?: MigrationPatternId;
	/**
	 * How records travel in this run, as the plan recorded it: `hub` through
	 * the canonical envelope, `native` through the engine's own transport.
	 * Absent for a plan that predates the field, which ran the hub.
	 */
	readonly realization?: MigrationRealization;
	/** The native migration profile, for a `native` realization. */
	readonly profile?: string;
	readonly completedPhases: readonly MigrationPhase[];
	/** Checkpoint each completed phase recorded, by phase. */
	readonly checkpoints: Readonly<Partial<Record<MigrationPhase, JsonObject>>>;
	readonly cutOver: boolean;
	/**
	 * A rollback was decided and journaled. Until `RolledBack` follows, a
	 * resumed run finishes handing authority back; it consults nobody again.
	 */
	readonly rollbackDecided: boolean;
	readonly heldAt?: MigrationPhase;
	readonly heldReason?: string;
}

export function initialMigrationState(migrationId: string): MigrationState {
	return Object.freeze({
		migrationId,
		status: "new",
		completedPhases: Object.freeze([]),
		checkpoints: Object.freeze({}),
		cutOver: false,
		rollbackDecided: false,
	});
}

function isPhase(value: JsonValue | undefined): value is MigrationPhase {
	return (
		isJsonString(value) &&
		// SAFETY: membership test against the closed tuple of phase names.
		(MIGRATION_PHASES as readonly string[]).includes(value)
	);
}

/**
 * The aggregate's fold. Total over every `migration.*` fact: an unrecognised
 * type leaves the state unchanged rather than wedging a replay.
 *
 * `completed` and `rolled-back` are absorbing. A fact that arrives after
 * either — a late `Held`, a stray `PhaseApplied` — changes nothing, so a
 * finished migration cannot be reopened by whatever is appended next.
 */
export function evolveMigration(
	state: MigrationState,
	fact: MigrationFact,
): MigrationState {
	if (state.status === "completed" || state.status === "rolled-back") {
		return state;
	}
	const { data } = fact;
	switch (fact.type) {
		case MIGRATION_EVENTS.Planned: {
			const pattern = data.pattern;
			const realization = data.realization;
			const profile = data.profile;
			return Object.freeze({
				...state,
				status: "running",
				...(isJsonString(pattern) && isMigrationPatternId(pattern)
					? { pattern }
					: undefined),
				...(isRealization(realization) ? { realization } : undefined),
				...(isJsonString(profile) ? { profile } : undefined),
			});
		}
		case MIGRATION_EVENTS.PhaseApplied: {
			const phase = data.phase;
			// Legacy expand/backfill/contract facts carry no uniform phase name.
			if (!isPhase(phase)) return state;
			const checkpoint = isJsonObject(data.checkpoint) ? data.checkpoint : {};
			const { heldAt: _heldAt, heldReason: _heldReason, ...rest } = state;
			return Object.freeze({
				...rest,
				status: "running",
				completedPhases: Object.freeze(
					state.completedPhases.includes(phase)
						? [...state.completedPhases]
						: [...state.completedPhases, phase],
				),
				checkpoints: Object.freeze({
					...state.checkpoints,
					[phase]: checkpoint,
				}),
			});
		}
		case MIGRATION_EVENTS.CutOver:
			return Object.freeze({ ...state, cutOver: true });
		case MIGRATION_EVENTS.Held: {
			const phase = data.phase;
			const reason = data.reason;
			return Object.freeze({
				...state,
				status: "held",
				...(isPhase(phase) ? { heldAt: phase } : undefined),
				...(isJsonString(reason) ? { heldReason: reason } : undefined),
			});
		}
		case MIGRATION_EVENTS.Resumed: {
			const { heldAt: _heldAt, heldReason: _heldReason, ...rest } = state;
			return Object.freeze({ ...rest, status: "running" });
		}
		case MIGRATION_EVENTS.RollbackDecided:
			return Object.freeze({ ...state, rollbackDecided: true });
		case MIGRATION_EVENTS.Completed:
			return Object.freeze({ ...state, status: "completed" });
		case MIGRATION_EVENTS.RolledBack:
			return Object.freeze({ ...state, status: "rolled-back", cutOver: false });
		case MIGRATION_EVENTS.Failed:
			return Object.freeze({ ...state, status: "failed" });
		default:
			return state;
	}
}

export function foldMigration(
	migrationId: string,
	facts: readonly MigrationFact[],
): MigrationState {
	let state = initialMigrationState(migrationId);
	for (const fact of facts) state = evolveMigration(state, fact);
	return state;
}

/**
 * A migration may hold only in a safe-hold phase. The fence-and-flip step is
 * the one phase that either completes or compensates; asking to hold inside
 * it is a programming error, refused before any fact is written.
 */
export function assertHoldable(phase: MigrationPhase): void {
	if (!isSafeHold(phase)) {
		throw new DataCoreError(
			"ILLEGAL_PHASE_TRANSITION",
			`${phase} is not a safe hold; it must complete or compensate`,
			{ detail: { phase } },
		);
	}
}

/** Where a migration's facts are appended and replayed from. */
export interface MigrationJournal {
	load(migrationId: string): Awaitable<readonly MigrationFact[]>;
	/**
	 * Append one fact, on the condition that the journal holds exactly
	 * `expectedCount` facts for this migration — the number the caller loaded,
	 * plus those it has appended itself. Any other count is refused with
	 * `JournalConflictError` and nothing is appended: a compare-and-set on the
	 * head, which is what keeps two drivers of one migration from both
	 * deciding from a view only one of them still has.
	 */
	append(
		migrationId: string,
		fact: MigrationFact,
		expectedCount: number,
	): Awaitable<void>;
}

export function createMemoryMigrationJournal(): MigrationJournal {
	const streams = new Map<string, MigrationFact[]>();
	return Object.freeze({
		load(migrationId: string): readonly MigrationFact[] {
			return Object.freeze([...(streams.get(migrationId) ?? [])]);
		},
		append(
			migrationId: string,
			fact: MigrationFact,
			expectedCount: number,
		): void {
			const existing = streams.get(migrationId) ?? [];
			if (existing.length !== expectedCount) {
				throw new JournalConflictError(migrationId, expectedCount);
			}
			existing.push(fact);
			streams.set(migrationId, existing);
		},
	});
}

export interface EventStoreJournalContext {
	readonly tenant: string;
	readonly actor: PrincipalRef;
}

// public-contract: stream id prefix a migration's facts are appended under.
export const MIGRATION_STREAM_PREFIX = "migration:";

/**
 * A journal over the durable event store: one stream per migration, appended
 * under optimistic `seq`. This is the production journal — a migration's
 * state then survives a restart and replays like any other aggregate. The
 * stream must hold this migration's facts and nothing else.
 */
export function createEventStoreMigrationJournal(
	store: Pick<EventStore, "append" | "read">,
	context: EventStoreJournalContext,
): MigrationJournal {
	const streamId = (migrationId: string) =>
		`${MIGRATION_STREAM_PREFIX}${migrationId}`;
	return Object.freeze({
		async load(migrationId: string): Promise<readonly MigrationFact[]> {
			const facts: MigrationFact[] = [];
			for await (const event of store.read(streamId(migrationId))) {
				facts.push(
					Object.freeze({
						type: event.type,
						// SAFETY: migration facts are appended by this journal as JSON objects.
						data: (isJsonObject(event.data) ? event.data : {}) as JsonObject,
					}),
				);
			}
			// A stream written by an earlier release holds bodies of an earlier
			// version: lifted here, before anything folds them.
			return liftMigrationFacts(facts);
		},
		async append(
			migrationId: string,
			fact: MigrationFact,
			expectedCount: number,
		): Promise<void> {
			// One fact is one event and a stream's sequence starts at one, so
			// the count the run holds is the sequence the stream must be at.
			// The store's own optimistic check is the compare-and-set; the head
			// is never read again here, because re-reading it is what let a
			// stale driver's append succeed.
			try {
				await store.append(
					streamId(migrationId),
					[
						{
							type: fact.type,
							v: migrationFactVersion(fact.type),
							data: fact.data,
						},
					],
					{
						expectedSeq: expectedCount,
						actor: context.actor,
						tenant: context.tenant,
					},
				);
			} catch (error) {
				if (error instanceof Error && isEventStoreOptimisticConflict(error)) {
					throw new JournalConflictError(migrationId, expectedCount, {
						cause: error,
					});
				}
				throw error;
			}
		},
	});
}
