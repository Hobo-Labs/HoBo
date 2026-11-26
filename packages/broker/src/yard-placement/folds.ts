/**
 * Pure event-store folds for Yard inventory, generation saga, and placement.
 * Rebuildable from zero — no in-memory mutation outside applying facts.
 */

import { must } from "@hobo/core/total-access";
import {
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import { YARD_EVENTS, type YardEvent } from "./events.js";
import {
	type ContentHash,
	contentHashOf,
	YARD_INSTANCE_SCHEMA,
	YARD_INVENTORY_SCHEMA,
	type YardGenerationResult,
	type YardInstanceRegistration,
	type YardInstanceStatus,
	type YardInventorySnapshot,
	type YardMatchDecision,
	type YardPlacementReceipt,
} from "./types.js";

export interface YardGenerationAttemptRow {
	readonly attemptId: string;
	readonly idempotencyKey: string;
	readonly providerId: string;
	readonly runtimeId: string;
	readonly expectedYardId: string;
	readonly status:
		| YardGenerationResult["status"]
		| "reserved"
		| "approval-required"
		| "compensated";
	readonly yardId?: string;
	readonly externalRefs: Readonly<Record<string, string>>;
	readonly failure?: {
		readonly code: string;
		readonly message: string;
		readonly retryable: boolean;
	};
	readonly contributingEvents: readonly string[];
}

export interface YardPlacementDecisionRow {
	readonly requestId: string;
	readonly outcome: "resolved" | "rejected" | "pending";
	readonly selectedYardId?: string;
	readonly selectedProviderId?: string;
	readonly selectedCampId?: string;
	readonly generationAttemptId?: string;
	readonly matchOutcome?: string;
	readonly reasonCodes: readonly string[];
	readonly receiptHash?: ContentHash;
}

/**
 * Full yard event-store projection state (inventory + generation + placements).
 */
export interface YardEventStoreState {
	readonly brokerId: string;
	readonly seq: number;
	readonly yards: Readonly<Record<string, YardInstanceRegistration>>;
	readonly generationAttempts: Readonly<
		Record<string, YardGenerationAttemptRow>
	>;
	/** Index idempotencyKey → attemptId for lease/dedup. */
	readonly generationByIdempotency: Readonly<Record<string, string>>;
	readonly placements: Readonly<Record<string, YardPlacementDecisionRow>>;
	readonly lastMatchByRequest: Readonly<Record<string, YardMatchDecision>>;
}

export function emptyYardEventStoreState(
	brokerId: string,
): YardEventStoreState {
	return Object.freeze({
		brokerId,
		seq: 0,
		yards: Object.freeze({}),
		generationAttempts: Object.freeze({}),
		generationByIdempotency: Object.freeze({}),
		placements: Object.freeze({}),
		lastMatchByRequest: Object.freeze({}),
	});
}

/**
 * Pure fold: apply one yard.* fact. Provider fold resolvers may pre-normalize
 * provider-native signals into yard.* events before calling this.
 */
export function foldYardEventStore(
	state: YardEventStoreState,
	event: YardEvent,
): YardEventStoreState {
	const seq = Math.max(state.seq, event.seq ?? state.seq + 1);
	const data = event.data;
	const type = event.type;

	if (type === YARD_EVENTS.PlacementRequested) {
		const requestId = str(data.requestId);
		if (!requestId) return withSeq(state, seq);
		return freezeState({
			...state,
			seq,
			placements: {
				...state.placements,
				[requestId]: {
					requestId,
					outcome: "pending",
					reasonCodes: Object.freeze([]),
				},
			},
		});
	}

	if (type === YARD_EVENTS.MatchDecided) {
		const requestId = str(data.requestId);
		// SAFETY: assertion required at this I/O or test boundary.
		const match = data.match as YardMatchDecision | undefined;
		if (!requestId || !match) return withSeq(state, seq);
		const prior = state.placements[requestId];
		return freezeState({
			...state,
			seq,
			lastMatchByRequest: {
				...state.lastMatchByRequest,
				[requestId]: match,
			},
			placements: {
				...state.placements,
				[requestId]: {
					requestId,
					outcome: prior?.outcome ?? "pending",
					...(match.winnerYardId
						? { selectedYardId: match.winnerYardId }
						: undefined),
					matchOutcome: match.outcome,
					reasonCodes: Object.freeze(
						match.outcome === "rejected"
							? ["yard-match-rejected"]
							: [...(prior?.reasonCodes ?? [])],
					),
					...(prior?.generationAttemptId
						? { generationAttemptId: prior.generationAttemptId }
						: undefined),
					...(prior?.selectedProviderId
						? { selectedProviderId: prior.selectedProviderId }
						: undefined),
					...(prior?.selectedCampId
						? { selectedCampId: prior.selectedCampId }
						: undefined),
					...(prior?.receiptHash
						? { receiptHash: prior.receiptHash }
						: undefined),
				},
			},
		});
	}

	if (
		type === YARD_EVENTS.GenerationRequested ||
		type === YARD_EVENTS.GenerationReserved
	) {
		return foldGenerationLifecycle(state, seq, data, type);
	}
	if (type === YARD_EVENTS.GenerationApprovalRequired) {
		return upsertAttempt(state, seq, data, "approval-required");
	}
	if (type === YARD_EVENTS.GenerationStarted) {
		return upsertAttempt(state, seq, data, "started");
	}
	if (type === YARD_EVENTS.GenerationProgressed) {
		return upsertAttempt(
			state,
			seq,
			data,
			// SAFETY: assertion required at this I/O or test boundary.
			(str(data.status) as YardGenerationAttemptRow["status"]) || "started",
		);
	}
	if (type === YARD_EVENTS.GenerationProvisioned) {
		return upsertAttempt(state, seq, data, "provisioned");
	}
	if (type === YARD_EVENTS.GenerationFailed) {
		return upsertAttempt(state, seq, data, "failed");
	}
	if (type === YARD_EVENTS.GenerationCompensationRequested) {
		return upsertAttempt(state, seq, data, "failed");
	}
	if (type === YARD_EVENTS.GenerationCompensated) {
		return upsertAttempt(state, seq, data, "compensated");
	}

	if (type === YARD_EVENTS.Registered) {
		// SAFETY: assertion required at this I/O or test boundary.
		const yard = data.yard as YardInstanceRegistration | undefined;
		if (!yard?.yardId) return withSeq(state, seq);
		const registered: YardInstanceRegistration = Object.freeze({
			...yard,
			schemaVersion: YARD_INSTANCE_SCHEMA,
			status: yard.status === "ready" ? "ready" : "registering",
			registrationSeq: yard.registrationSeq || seq,
		});
		return freezeState({
			...state,
			seq,
			yards: { ...state.yards, [registered.yardId]: registered },
		});
	}

	if (type === YARD_EVENTS.AttestationStarted) {
		return patchYardStatus(state, seq, str(data.yardId), "attesting");
	}
	if (type === YARD_EVENTS.Attested) {
		return patchYardStatus(state, seq, str(data.yardId), "attesting");
	}
	if (type === YARD_EVENTS.Ready) {
		const yardId = str(data.yardId);
		const next = patchYardStatus(state, seq, yardId, "ready");
		// Link generation attempt → ready yard
		const attemptId = str(data.attemptId);
		if (attemptId && next.generationAttempts[attemptId]) {
			const attempt = must(
				next.generationAttempts[attemptId],
				"next.generationAttempts[attemptId]",
			);
			const readyYardId = yardId || attempt.yardId;
			const updated: YardGenerationAttemptRow = {
				attemptId: attempt.attemptId,
				idempotencyKey: attempt.idempotencyKey,
				providerId: attempt.providerId,
				runtimeId: attempt.runtimeId,
				expectedYardId: attempt.expectedYardId,
				status: "ready",
				externalRefs: attempt.externalRefs,
				contributingEvents: Object.freeze([
					...attempt.contributingEvents,
					type,
				]),
				...(readyYardId ? { yardId: readyYardId } : undefined),
				...(attempt.failure ? { failure: attempt.failure } : undefined),
			};
			return freezeState({
				...next,
				generationAttempts: {
					...next.generationAttempts,
					[attemptId]: Object.freeze(updated),
				},
			});
		}
		return next;
	}

	if (type === YARD_EVENTS.StatusChanged) {
		const yardId = str(data.yardId);
		// SAFETY: assertion required at this I/O or test boundary.
		const status = str(data.status) as YardInstanceStatus;
		if (!yardId || !status) return withSeq(state, seq);
		return patchYardStatus(state, seq, yardId, status);
	}

	if (type === YARD_EVENTS.CapacityUpdated) {
		const yardId = str(data.yardId);
		// SAFETY: assertion required at this I/O or test boundary.
		const capacity = data.capacity as YardInstanceRegistration["capacity"];
		const existing = state.yards[yardId];
		if (!existing || !capacity) return withSeq(state, seq);
		return freezeState({
			...state,
			seq,
			yards: {
				...state.yards,
				[yardId]: { ...existing, capacity },
			},
		});
	}

	if (type === YARD_EVENTS.PlacementResolved) {
		const requestId = str(data.requestId);
		if (!requestId) return withSeq(state, seq);
		// SAFETY: assertion required at this I/O or test boundary.
		const receipt = data.receipt as YardPlacementReceipt | undefined;
		const prior = state.placements[requestId];
		const selectedYardId =
			str(data.selectedYardId) ||
			receipt?.selectedYardId ||
			prior?.selectedYardId;
		const selectedProviderId =
			str(data.selectedProviderId) ||
			receipt?.selectedProviderId ||
			prior?.selectedProviderId;
		const selectedCampId =
			str(data.selectedCampId) ||
			receipt?.selectedCampId ||
			prior?.selectedCampId;
		const generationAttemptId =
			str(data.generationAttemptId) || prior?.generationAttemptId;
		const receiptHash =
			// SAFETY: assertion required at this I/O or test boundary.
			(data.receiptHash as ContentHash | undefined) ||
			// SAFETY: assertion required at this I/O or test boundary.
			(receipt?.contentHash as ContentHash | undefined);
		const row: YardPlacementDecisionRow = {
			requestId,
			outcome: "resolved",
			matchOutcome: prior?.matchOutcome ?? "existing-yard",
			reasonCodes: Object.freeze([]),
			...(selectedYardId ? { selectedYardId } : undefined),
			...(selectedProviderId ? { selectedProviderId } : undefined),
			...(selectedCampId ? { selectedCampId } : undefined),
			...(generationAttemptId ? { generationAttemptId } : undefined),
			...(receiptHash ? { receiptHash } : undefined),
		};
		return freezeState({
			...state,
			seq,
			placements: {
				...state.placements,
				[requestId]: Object.freeze(row),
			},
		});
	}

	if (type === YARD_EVENTS.PlacementRejected) {
		const requestId = str(data.requestId);
		if (!requestId) return withSeq(state, seq);
		const codes = Array.isArray(data.reasonCodes)
			? data.reasonCodes.map(String)
			: [str(data.code) || "placement-rejected"];
		const prior = state.placements[requestId];
		return freezeState({
			...state,
			seq,
			placements: {
				...state.placements,
				[requestId]: {
					requestId,
					outcome: "rejected",
					reasonCodes: Object.freeze(codes.filter(Boolean)),
					...(prior?.selectedYardId
						? { selectedYardId: prior.selectedYardId }
						: undefined),
					...(prior?.matchOutcome
						? { matchOutcome: prior.matchOutcome }
						: undefined),
				},
			},
		});
	}

	// ProviderSignalNormalized is informational; provider resolvers expand it first.
	return withSeq(state, seq);
}

export function foldYardEventStoreAll(
	brokerId: string,
	events: Iterable<YardEvent>,
): YardEventStoreState {
	let state = emptyYardEventStoreState(brokerId);
	for (const event of events) {
		state = foldYardEventStore(state, event);
	}
	return state;
}

/** Project fold state → inventory snapshot (pinned hash). */
export function inventorySnapshotFromFold(
	state: YardEventStoreState,
): YardInventorySnapshot {
	const yards = Object.values(state.yards).sort((a, b) =>
		a.yardId < b.yardId ? -1 : a.yardId > b.yardId ? 1 : 0,
	);
	const body = {
		schemaVersion: YARD_INVENTORY_SCHEMA,
		brokerId: state.brokerId,
		seq: state.seq,
		yards,
	};
	return Object.freeze({
		...body,
		yards: Object.freeze(yards),
		// SAFETY: assertion required at this I/O or test boundary.
		contentHash: contentHashOf(body) as ContentHash,
	});
}

export function snapshotYardEventStore(state: YardEventStoreState): string {
	return JSON.stringify({
		schemaVersion: "hobo.yard-event-store/v1",
		state,
	});
}

export function restoreYardEventStore(snapshot: string): YardEventStoreState {
	// SAFETY: assertion required at this I/O or test boundary.
	const parsed = JSON.parse(snapshot) as {
		schemaVersion?: string;
		state?: YardEventStoreState;
	};
	if (parsed.schemaVersion !== "hobo.yard-event-store/v1" || !parsed.state) {
		throw new Error(
			`unsupported yard event-store snapshot: ${String(parsed.schemaVersion)}`,
		);
	}
	return freezeState(parsed.state);
}

// ---- internals ----

function foldGenerationLifecycle(
	state: YardEventStoreState,
	seq: number,
	data: JsonObject,
	type: string,
): YardEventStoreState {
	const status =
		type === YARD_EVENTS.GenerationReserved ? "reserved" : "started";
	return upsertAttempt(state, seq, data, status);
}

function upsertAttempt(
	state: YardEventStoreState,
	seq: number,
	data: JsonObject,
	status: YardGenerationAttemptRow["status"],
): YardEventStoreState {
	const attemptId = str(data.attemptId);
	const idempotencyKey = str(data.idempotencyKey);
	if (!attemptId) return withSeq(state, seq);

	// Lease: if another attempt owns this idempotency key, keep the winner.
	if (
		idempotencyKey &&
		state.generationByIdempotency[idempotencyKey] &&
		state.generationByIdempotency[idempotencyKey] !== attemptId
	) {
		const winnerId = must(
			state.generationByIdempotency[idempotencyKey],
			"state.generationByIdempotency[idempotencyKey]",
		);
		const winner = state.generationAttempts[winnerId];
		if (
			winner &&
			winner.status !== "failed" &&
			winner.status !== "compensated"
		) {
			return withSeq(state, seq);
		}
	}

	const prior = state.generationAttempts[attemptId];
	const externalRefs = {
		...prior?.externalRefs,
		// SAFETY: assertion required at this I/O or test boundary.
		...(data.externalRefs as Record<string, string> | undefined),
	};
	const yardId = str(data.yardId) || prior?.yardId;
	const failure =
		data.failure && isJsonObject(data.failure)
			? Object.freeze(
					// SAFETY: assertion required at this I/O or test boundary.
					data.failure as {
						readonly code: string;
						readonly message: string;
						readonly retryable: boolean;
					},
				)
			: prior?.failure;
	const row: YardGenerationAttemptRow = Object.freeze({
		attemptId,
		idempotencyKey: idempotencyKey || prior?.idempotencyKey || attemptId,
		providerId: str(data.providerId) || prior?.providerId || "",
		runtimeId: str(data.runtimeId) || prior?.runtimeId || "",
		expectedYardId: str(data.expectedYardId) || prior?.expectedYardId || "",
		status,
		externalRefs: Object.freeze(externalRefs),
		contributingEvents: Object.freeze([
			...(prior?.contributingEvents ?? []),
			String(data.eventType || status),
		]),
		...(yardId ? { yardId } : undefined),
		...(failure ? { failure } : undefined),
	});

	return freezeState({
		...state,
		seq,
		generationAttempts: {
			...state.generationAttempts,
			[attemptId]: row,
		},
		generationByIdempotency: {
			...state.generationByIdempotency,
			[row.idempotencyKey]: attemptId,
		},
	});
}

function patchYardStatus(
	state: YardEventStoreState,
	seq: number,
	yardId: string,
	status: YardInstanceStatus,
): YardEventStoreState {
	if (!yardId) return withSeq(state, seq);
	const existing = state.yards[yardId];
	if (!existing) return withSeq(state, seq);
	const observedAt = new Date().toISOString();
	return freezeState({
		...state,
		seq,
		yards: {
			...state.yards,
			[yardId]: {
				...existing,
				status,
				health: {
					...existing.health,
					observedAt,
					generation: existing.health.generation + 1,
				},
			},
		},
	});
}

function withSeq(state: YardEventStoreState, seq: number): YardEventStoreState {
	if (seq === state.seq) return state;
	return freezeState({ ...state, seq });
}

function freezeState(state: YardEventStoreState): YardEventStoreState {
	return Object.freeze({
		brokerId: state.brokerId,
		seq: state.seq,
		yards: Object.freeze({ ...state.yards }),
		generationAttempts: Object.freeze({ ...state.generationAttempts }),
		generationByIdempotency: Object.freeze({
			...state.generationByIdempotency,
		}),
		placements: Object.freeze({ ...state.placements }),
		lastMatchByRequest: Object.freeze({ ...state.lastMatchByRequest }),
	});
}

function str(value: JsonValue | undefined): string {
	return isJsonString(value) ? value : "";
}
