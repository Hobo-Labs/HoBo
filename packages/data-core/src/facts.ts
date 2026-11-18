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

export interface MigrationFact {
	readonly type: string;
	readonly data: JsonObject;
}

export const MIGRATION_FACT_VERSIONS: Readonly<Record<string, number>> =
	Object.freeze({
		[MIGRATION_EVENTS.Planned]: 2,
		[MIGRATION_EVENTS.PhaseApplied]: 2,
		[MIGRATION_EVENTS.CutOver]: 2,
		[MIGRATION_EVENTS.RolledBack]: 2,
	});

export function migrationFactVersion(type: string): number {
	return MIGRATION_FACT_VERSIONS[type] ?? 1;
}

export function fenceTokenDigest(fenceToken: string): string {
	return `sha256:${sha256Hex(fenceToken)}`;
}

const IN_PLACE_PLAN_PHASES: readonly string[] = Object.freeze([
	"expand",
	"backfill",
	"contract",
]);

function withoutFenceToken(body: JsonObject): JsonObject | undefined {
	const { fenceToken, ...kept } = body;
	if (!isJsonString(fenceToken)) return undefined;
	return { ...kept, fenceTokenDigest: fenceTokenDigest(fenceToken) };
}

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

export function liftMigrationFacts(
	facts: readonly MigrationFact[],
): readonly MigrationFact[] {
	return Object.freeze(facts.map((fact) => liftMigrationFact(fact)));
}

export const FENCE_SIDES = ["source", "target"] as const;
export type FenceSide = (typeof FENCE_SIDES)[number];

export const MIGRATION_REALIZATIONS = ["native", "hub"] as const;
export type MigrationRealization = (typeof MIGRATION_REALIZATIONS)[number];

function isRealization(
	value: JsonValue | undefined,
): value is MigrationRealization {
	return (
		isJsonString(value) &&
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

export interface MigrationState {
	readonly migrationId: string;
	readonly status: MigrationStatus;
	readonly pattern?: MigrationPatternId;
	readonly realization?: MigrationRealization;
	readonly profile?: string;
	readonly completedPhases: readonly MigrationPhase[];
	readonly checkpoints: Readonly<Partial<Record<MigrationPhase, JsonObject>>>;
	readonly cutOver: boolean;
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
		(MIGRATION_PHASES as readonly string[]).includes(value)
	);
}

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

export function assertHoldable(phase: MigrationPhase): void {
	if (!isSafeHold(phase)) {
		throw new DataCoreError(
			"ILLEGAL_PHASE_TRANSITION",
			`${phase} is not a safe hold; it must complete or compensate`,
			{ detail: { phase } },
		);
	}
}

export interface MigrationJournal {
	load(migrationId: string): Awaitable<readonly MigrationFact[]>;
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

export const MIGRATION_STREAM_PREFIX = "migration:";

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
						data: (isJsonObject(event.data) ? event.data : {}) as JsonObject,
					}),
				);
			}
			return liftMigrationFacts(facts);
		},
		async append(
			migrationId: string,
			fact: MigrationFact,
			expectedCount: number,
		): Promise<void> {
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
