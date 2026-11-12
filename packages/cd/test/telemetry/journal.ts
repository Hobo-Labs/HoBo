// Journal fixtures for the WP19 telemetry tests: append the same proto-JSON
// bodies the freight ledger (WP1), promotion saga (WP6), desired-state store
// (WP4) and reconcilers (WP7) record, at controlled times.
import { create, toJson } from "@bufbuild/protobuf";
import type { JsonObject } from "@hobo/core";
import {
	FreightRecordSchema,
	FreightSubject,
	PromotionRecordSchema,
	PromotionState,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	SetRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import {
	type Clock,
	type MemoryEventStore,
	OPERATOR,
	TENANT,
} from "../authz/memory-store.js";

export type Journal = Readonly<{
	store: MemoryEventStore;
	clock: Clock;
}>;

async function append(
	j: Journal,
	atMs: number,
	streamId: string,
	type: string,
	data: JsonObject,
): Promise<void> {
	j.clock.set(atMs);
	const seq = j.store.stream(streamId).length;
	await j.store.append(streamId, [{ type, data }], {
		expectedSeq: seq,
		actor: OPERATOR,
		tenant: TENANT,
	});
}

function json<T>(value: T): JsonObject {
	// SAFETY: proto toJson of a message is always a JSON object.
	return value as unknown as JsonObject;
}

export async function recordFreight(
	j: Journal,
	atMs: number,
	freightId: string,
): Promise<void> {
	await append(
		j,
		atMs,
		CD_STREAMS.freight(freightId),
		CD_EVENTS.FreightRecorded,
		json(
			toJson(
				FreightRecordSchema,
				create(FreightRecordSchema, {
					schemaVersion: "hobo.cd.freight/v1",
					freightId,
					alias: "brave-otter",
					recordedBy: "user:ops@acme",
					recordedAt: new Date(atMs).toISOString(),
				}),
			),
		),
	);
}

export type PromotionFixture = Readonly<{
	promotionId: string;
	freightId: string;
	targets: readonly string[];
	pipeline?: string;
	node?: string;
	subject?: FreightSubject;
}>;

function promotion(
	p: PromotionFixture,
	state: PromotionState,
	targets: readonly string[],
) {
	return json(
		toJson(
			PromotionRecordSchema,
			create(PromotionRecordSchema, {
				schemaVersion: "hobo.cd.promotion/v1",
				promotionId: p.promotionId,
				freightId: p.freightId,
				targetCampIds: [...targets],
				pipeline: p.pipeline ?? "",
				node: p.node ?? "",
				state,
				requestedBy: "user:ops@acme",
				subject: p.subject ?? FreightSubject.BINDLE,
			}),
		),
	);
}

export async function requestPromotion(
	j: Journal,
	atMs: number,
	p: PromotionFixture,
): Promise<void> {
	await append(
		j,
		atMs,
		CD_STREAMS.promotion(p.promotionId),
		CD_EVENTS.EnvPromoteRequested,
		promotion(p, PromotionState.QUEUED, p.targets),
	);
}

export async function promoted(
	j: Journal,
	atMs: number,
	p: PromotionFixture,
	campId: string,
): Promise<void> {
	await append(
		j,
		atMs,
		CD_STREAMS.promotion(p.promotionId),
		CD_EVENTS.EnvPromoted,
		promotion(p, PromotionState.PROMOTED, [campId]),
	);
}

export async function rejected(
	j: Journal,
	atMs: number,
	p: PromotionFixture,
	campId: string,
	state: PromotionState = PromotionState.FAILED,
): Promise<void> {
	await append(
		j,
		atMs,
		CD_STREAMS.promotion(p.promotionId),
		CD_EVENTS.EnvPromoteRejected,
		promotion(p, state, [campId]),
	);
}

/** A rollback promotion's terminal event on its own stream (as WP6 records it). */
export async function rolledBack(
	j: Journal,
	atMs: number,
	rollbackId: string,
	freightId: string,
	campId: string,
): Promise<void> {
	await append(
		j,
		atMs,
		CD_STREAMS.promotion(rollbackId),
		CD_EVENTS.EnvPromoteRolledBack,
		promotion(
			{ promotionId: rollbackId, freightId, targets: [campId] },
			PromotionState.ROLLED_BACK,
			[campId],
		),
	);
}

export async function desiredSet(
	j: Journal,
	atMs: number,
	campId: string,
	setId: string,
): Promise<void> {
	await append(
		j,
		atMs,
		CD_STREAMS.campSpec(campId),
		CD_EVENTS.SetCreated,
		json(
			toJson(
				SetRecordSchema,
				create(SetRecordSchema, {
					schemaVersion: "hobo.cd.set/v1",
					setId,
					tenant: TENANT,
					campId,
					createdAt: new Date(atMs).toISOString(),
				}),
			),
		),
	);
}

export async function converged(
	j: Journal,
	atMs: number,
	campId: string,
	setId: string,
): Promise<void> {
	await append(
		j,
		atMs,
		CD_STREAMS.campStatus(campId),
		CD_EVENTS.Converged,
		json(
			toJson(
				ReconcileObservationRecordSchema,
				create(ReconcileObservationRecordSchema, {
					campId,
					setId,
					reconcilerId: "rec-1",
					fenceToken: "1",
					status: ReconcileStatus.CONVERGED,
					observedAt: new Date(atMs).toISOString(),
				}),
			),
		),
	);
}
