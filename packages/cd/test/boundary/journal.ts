// A fixed CD journal used by the boundary golden tests. Bodies are the
// generated protobuf records rendered with toJson, exactly as the owning
// modules append them.
import { create, type DescMessage, toJson } from "@bufbuild/protobuf";
import type { EventEnvelope, JsonObject } from "@hobo/core";
import {
	ArtifactKind,
	FailoverRecordSchema,
	FailoverState,
	FanoutState,
	FanoutStatusRecordSchema,
	FreightQualifiedRecordSchema,
	FreightRecordSchema,
	FreightSubject,
	FreightYankedRecordSchema,
	PreviewEnvironmentRecordSchema,
	PromotionRecordSchema,
	PromotionState,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	SetOrigin,
	SetRecordSchema,
	VerificationResultRecordSchema,
	VerificationVerdict,
} from "../../src/_generated/cd_pb.js";
import { cloneAsJson, isJsonObject } from "../../src/boundary/json.js";
import { CD_EVENTS } from "../../src/events.js";

const F1 = `sha256:${"1".repeat(64)}`;
const F2 = `sha256:${"2".repeat(64)}`;
const RAIL = `sha256:${"3".repeat(64)}`;

let seq = 0;

/** The protobuf JSON body of a generated message. */
function body<D extends DescMessage>(
	schema: D,
	message: Parameters<typeof toJson<D>>[1],
): JsonObject {
	const json = cloneAsJson(toJson(schema, message));
	return isJsonObject(json) ? json : {};
}
function envelope(
	type: string,
	streamId: string,
	data: JsonObject,
	minute: number,
	correlationId?: string,
): EventEnvelope<JsonObject> {
	seq += 1;
	return {
		id: `evt-${String(seq).padStart(3, "0")}`,
		type,
		v: 1,
		streamId,
		seq,
		ts: `2026-11-12T10:${String(minute).padStart(2, "0")}:00.000Z`,
		actor: { kind: "service", id: "cd" },
		tenant: "acme",
		data,
		...(correlationId !== undefined ? { correlationId } : undefined),
	};
}

export function fixtureJournal(): EventEnvelope<JsonObject>[] {
	seq = 0;
	const artifacts = [
		{
			name: "web",
			kind: ArtifactKind.OCI_IMAGE,
			digest: `sha256:${"a".repeat(64)}`,
			coordinate: "registry.example/acme/web",
			ecosystem: "oci",
		},
		{
			name: "assets",
			kind: ArtifactKind.STATIC_ASSETS,
			digest: `sha256:${"b".repeat(64)}`,
			coordinate: "pkg:npm/%40acme/assets@1.4.0",
			ecosystem: "npm",
		},
	];
	return [
		envelope(
			CD_EVENTS.FreightRecorded,
			`cd-freight-${F1}`,
			body(
				FreightRecordSchema,
				create(FreightRecordSchema, {
					schemaVersion: "hobo.cd.freight/v1",
					freightId: F1,
					alias: "brave-otter",
					manifest: {
						schemaVersion: "hobo.freight-manifest/v1",
						bindle: "checkout",
						declarationHash: `sha256:${"d".repeat(64)}`,
						artifacts,
					},
					recordedAt: "2026-11-12T10:00:00.000Z",
				}),
			),
			0,
			F1,
		),
		envelope(
			CD_EVENTS.SetCreated,
			"cd-camp-staging",
			body(
				SetRecordSchema,
				create(SetRecordSchema, {
					setId: "set-1",
					campId: "staging",
					environment: "staging",
					freightId: F1,
					origin: SetOrigin.PROMOTION,
				}),
			),
			1,
			F1,
		),
		envelope(
			CD_EVENTS.EnvPromoted,
			"cd-promotion-p1",
			body(
				PromotionRecordSchema,
				create(PromotionRecordSchema, {
					promotionId: "p1",
					freightId: F1,
					targetCampIds: ["staging"],
					pipeline: "web",
					node: "staging",
					state: PromotionState.PROMOTED,
				}),
			),
			2,
			F1,
		),
		envelope(
			CD_EVENTS.VerificationCompleted,
			"cd-verification-v1",
			body(
				VerificationResultRecordSchema,
				create(VerificationResultRecordSchema, {
					verificationId: "v1",
					freightId: F1,
					campId: "staging",
					verdict: VerificationVerdict.PASS,
					startedAt: "2026-11-12T10:02:00.000Z",
					finishedAt: "2026-11-12T10:03:00.000Z",
				}),
			),
			3,
			F1,
		),
		envelope(
			CD_EVENTS.FreightQualified,
			`cd-freight-${F1}`,
			body(
				FreightQualifiedRecordSchema,
				create(FreightQualifiedRecordSchema, {
					freightId: F1,
					campId: "staging",
					pipeline: "web",
					node: "staging",
					verificationId: "v1",
					qualifiedAt: "2026-11-12T10:03:00.000Z",
				}),
			),
			3,
			F1,
		),
		envelope(
			CD_EVENTS.FreightRecorded,
			`cd-freight-${F2}`,
			body(
				FreightRecordSchema,
				create(FreightRecordSchema, {
					schemaVersion: "hobo.cd.freight/v1",
					freightId: F2,
					alias: "calm-heron",
					manifest: {
						schemaVersion: "hobo.freight-manifest/v1",
						bindle: "checkout",
						declarationHash: `sha256:${"e".repeat(64)}`,
						artifacts: [
							{ ...artifacts[0], digest: `sha256:${"c".repeat(64)}` },
						],
					},
				}),
			),
			4,
			F2,
		),
		envelope(
			CD_EVENTS.SetCreated,
			"cd-camp-staging",
			body(
				SetRecordSchema,
				create(SetRecordSchema, {
					setId: "set-2",
					campId: "staging",
					environment: "staging",
					freightId: F2,
					origin: SetOrigin.PROMOTION,
				}),
			),
			5,
			F2,
		),
		envelope(
			CD_EVENTS.EnvPromoted,
			"cd-promotion-p2",
			body(
				PromotionRecordSchema,
				create(PromotionRecordSchema, {
					promotionId: "p2",
					freightId: F2,
					targetCampIds: ["staging"],
					pipeline: "web",
					node: "staging",
					state: PromotionState.PROMOTED,
				}),
			),
			6,
			F2,
		),
		envelope(
			CD_EVENTS.EnvPromoteRolledBack,
			"cd-promotion-p2",
			body(
				PromotionRecordSchema,
				create(PromotionRecordSchema, {
					promotionId: "p2",
					freightId: F2,
					targetCampIds: ["staging"],
					state: PromotionState.ROLLED_BACK,
				}),
			),
			7,
			F2,
		),
		envelope(
			CD_EVENTS.FreightYanked,
			`cd-freight-${F2}`,
			body(
				FreightYankedRecordSchema,
				create(FreightYankedRecordSchema, {
					freightId: F2,
					reason: "canary error rate",
					yankedBy: "user:sre",
					yankedAt: "2026-11-12T10:08:00.000Z",
				}),
			),
			8,
			F2,
		),
		envelope(
			CD_EVENTS.SetCreated,
			"cd-camp-staging",
			body(
				SetRecordSchema,
				create(SetRecordSchema, {
					setId: "set-3",
					campId: "staging",
					environment: "staging",
					freightId: F1,
					origin: SetOrigin.CONFIG,
				}),
			),
			9,
		),
		envelope(
			CD_EVENTS.FanoutHalted,
			"cd-fanout-f1",
			body(
				FanoutStatusRecordSchema,
				create(FanoutStatusRecordSchema, {
					fanoutId: "f1",
					pipeline: "web",
					node: "prod",
					freightId: F1,
					state: FanoutState.HALTED,
					failed: ["edge-7"],
					deferred: ["edge-9"],
					updatedAt: "2026-11-12T10:10:00.000Z",
				}),
			),
			10,
		),
		envelope(
			CD_EVENTS.FailoverCompleted,
			"cd-failover-fo1",
			body(
				FailoverRecordSchema,
				create(FailoverRecordSchema, {
					failoverId: "fo1",
					fromCampId: "eu-1",
					toCampId: "eu-2",
					freightId: F1,
					state: FailoverState.COMPLETED,
					updatedAt: "2026-11-12T10:11:00.000Z",
				}),
			),
			11,
		),
		envelope(
			CD_EVENTS.EnvCloned,
			"cd-camp-pr-42",
			body(
				PreviewEnvironmentRecordSchema,
				create(PreviewEnvironmentRecordSchema, {
					campId: "pr-42",
					sourceCampId: "staging",
					freightId: F1,
				}),
			),
			12,
		),
		envelope(
			CD_EVENTS.SetCreated,
			"cd-camp-staging",
			body(
				SetRecordSchema,
				create(SetRecordSchema, {
					setId: "set-4",
					campId: "staging",
					environment: "staging",
					origin: SetOrigin.TEARDOWN,
				}),
			),
			13,
		),
		envelope(
			CD_EVENTS.Converged,
			"cd-camp-status-staging",
			body(
				ReconcileObservationRecordSchema,
				create(ReconcileObservationRecordSchema, {
					campId: "staging",
					setId: "set-4",
					reconcilerId: "r1",
					fenceToken: "7",
					status: ReconcileStatus.CONVERGED,
					observedAt: "2026-11-12T10:14:00.000Z",
				}),
			),
			14,
		),
		envelope(
			CD_EVENTS.EnvExpired,
			"cd-camp-pr-42",
			body(
				PreviewEnvironmentRecordSchema,
				create(PreviewEnvironmentRecordSchema, {
					campId: "pr-42",
				}),
			),
			15,
		),
		envelope(
			CD_EVENTS.FreightRecorded,
			`cd-freight-${RAIL}`,
			body(
				FreightRecordSchema,
				create(FreightRecordSchema, {
					schemaVersion: "hobo.cd.freight/v1",
					freightId: RAIL,
					alias: "quiet-lynx",
					manifest: {
						schemaVersion: "hobo.freight-manifest/v1",
						bindle: "rail-prod",
						declarationHash: `sha256:${"f".repeat(64)}`,
						subject: FreightSubject.RAIL,
					},
				}),
			),
			16,
		),
		// A body that does not parse is skipped, never trusted.
		{
			id: "evt-bad",
			type: CD_EVENTS.EnvPromoted,
			v: 1,
			streamId: "cd-promotion-bad",
			seq: 999,
			ts: "2026-11-12T10:17:00.000Z",
			actor: { kind: "service", id: "cd" },
			tenant: "acme",
			data: { targetCampIds: "not-a-list" },
		},
	];
}
