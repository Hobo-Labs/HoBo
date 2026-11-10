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
 */
import type { EventStore, PrincipalRef } from "@hobo/core";
import { DataCoreError } from "./errors.js";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
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
} as const);

export type MigrationEventType =
	(typeof MIGRATION_EVENTS)[keyof typeof MIGRATION_EVENTS];

// domain-view: in-process fact; each `data` body's wire form is the matching Migration*EventData message in data-models/data_core.proto.
export interface MigrationFact {
	readonly type: string;
	readonly data: JsonObject;
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
	readonly completedPhases: readonly MigrationPhase[];
	/** Checkpoint each completed phase recorded, by phase. */
	readonly checkpoints: Readonly<Partial<Record<MigrationPhase, JsonObject>>>;
	readonly cutOver: boolean;
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
 */
export function evolveMigration(
	state: MigrationState,
	fact: MigrationFact,
): MigrationState {
	const { data } = fact;
	switch (fact.type) {
		case MIGRATION_EVENTS.Planned: {
			const pattern = data.pattern;
			return Object.freeze({
				...state,
				status: "running",
				...(isJsonString(pattern) && isMigrationPatternId(pattern)
					? { pattern }
					: undefined),
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
	append(migrationId: string, fact: MigrationFact): Awaitable<void>;
}

export function createMemoryMigrationJournal(): MigrationJournal {
	const streams = new Map<string, MigrationFact[]>();
	return Object.freeze({
		load(migrationId: string): readonly MigrationFact[] {
			return Object.freeze([...(streams.get(migrationId) ?? [])]);
		},
		append(migrationId: string, fact: MigrationFact): void {
			const existing = streams.get(migrationId) ?? [];
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
 * state then survives a restart and replays like any other aggregate.
 */
export function createEventStoreMigrationJournal(
	store: EventStore,
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
			return Object.freeze(facts);
		},
		async append(migrationId: string, fact: MigrationFact): Promise<void> {
			let expectedSeq = 0;
			for await (const event of store.read(streamId(migrationId))) {
				expectedSeq = event.seq;
			}
			await store.append(
				streamId(migrationId),
				[{ type: fact.type, v: 1, data: fact.data }],
				{ expectedSeq, actor: context.actor, tenant: context.tenant },
			);
		},
	});
}
