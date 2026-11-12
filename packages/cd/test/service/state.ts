/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion -- SAFETY: fixtures brand ids they mint. */
// A small, deterministic CD world for read-API tests: one pipeline with a
// list node (staging) and a placed node (prod), three Camps, one Freight with
// qualifications, promotions, a fan-out, failovers and compliance.
import { create } from "@bufbuild/protobuf";
import {
	CampConditionRecordSchema,
	CampConditionType,
	CampManagement,
	CampStatusRecordSchema,
	ComplianceRecordSchema,
	ComplianceState,
	ConditionStatus,
	FailoverRecordSchema,
	FailoverState,
	FanoutState,
	FanoutStatusRecordSchema,
	FreightApprovedRecordSchema,
	FreightAvailabilityRecordSchema,
	FreightQualifiedRecordSchema,
	FreightRecordSchema,
	PipelineNodeRecordSchema,
	PipelineRecordSchema,
	PlacementDecisionRecordSchema,
	PlacementGroupDecisionRecordSchema,
	PromotionRecordSchema,
	PromotionState,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	SetRecordSchema,
	SignalSource,
	TaintEffect,
	TaintRecordSchema,
} from "../../src/_generated/cd_pb.js";
import { CD_EVENTS, CD_STREAMS } from "../../src/events.js";
import type { CampId, CampView } from "../../src/ports.js";
import { emptyState, type FacadeState, type FakeStore } from "./fakes.js";

export const FREIGHT_ID = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const RAIL_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function camp(
	id: string,
	set: string,
	opts: { ready?: boolean; taint?: { key: string; effect: TaintEffect } } = {},
): CampView {
	return {
		topology: {
			campId: id as CampId,
			yardId: "yard-eu",
			stationId: "station-1",
			provider: "vercel",
			regions: ["eu-west-1"],
			envType: "production",
			labels: { set },
			management: CampManagement.MANAGED,
		},
		status: create(CampStatusRecordSchema, {
			campId: id,
			management: CampManagement.MANAGED,
			conditions: [
				create(CampConditionRecordSchema, {
					type: CampConditionType.READY,
					status: opts.ready === false ? ConditionStatus.FALSE : ConditionStatus.TRUE,
					source: SignalSource.RECONCILER,
					reason: "observed",
					since: "2026-11-01T00:00:00.000Z",
				}),
			],
			taints: opts.taint
				? [
						create(TaintRecordSchema, {
							key: opts.taint.key,
							effect: opts.taint.effect,
							source: SignalSource.STATION,
							reason: "unreachable",
							addedBy: "station",
							addedAt: "2026-11-01T00:00:00.000Z",
						}),
					]
				: [],
			updatedAt: "2026-11-01T00:00:00.000Z",
		}),
	};
}

export function world(): FacadeState {
	const s = emptyState();
	s.pipelines.push(
		create(PipelineRecordSchema, {
			schemaVersion: "hobo.cd.pipeline/v1",
			name: "shop",
			bindle: "shop",
			nodes: [
				create(PipelineNodeRecordSchema, { name: "staging", campIds: ["stg-1"], fromSources: ["shop-oci"] }),
				create(PipelineNodeRecordSchema, { name: "prod", placement: "eu-fleet", fromNodes: ["staging"] }),
			],
			definedBy: "user:ops",
		}),
	);
	s.available["shop/prod"] = [
		create(FreightAvailabilityRecordSchema, {
			pipeline: "shop",
			node: "prod",
			freightId: FREIGHT_ID,
			via: ["staging"],
			availableAt: "2026-11-02T00:00:00.000Z",
		}),
	];
	s.freight.push(
		create(FreightRecordSchema, {
			schemaVersion: "hobo.cd.freight/v1",
			freightId: FREIGHT_ID,
			alias: "brave-otter",
			recordedBy: "service:ci",
			recordedAt: "2026-11-01T00:00:00.000Z",
		}),
	);
	s.qualifications.push(
		create(FreightQualifiedRecordSchema, {
			freightId: FREIGHT_ID,
			campId: "stg-1",
			pipeline: "shop",
			node: "staging",
			verificationId: "ver-1",
			qualifiedAt: "2026-11-01T02:00:00.000Z",
		}),
	);
	s.approvals.push(
		create(FreightApprovedRecordSchema, {
			freightId: FREIGHT_ID,
			campId: "eu-2",
			approvedBy: "user:ops",
			reason: "hotfix",
			decisionId: "dec-9",
			approvedAt: "2026-11-01T03:00:00.000Z",
			expiresAt: "2026-11-02T03:00:00.000Z",
		}),
	);
	s.promotions.push(
		create(PromotionRecordSchema, {
			schemaVersion: "hobo.cd.promotion/v1",
			promotionId: "prm-1",
			freightId: FREIGHT_ID,
			targetCampIds: ["stg-1"],
			pipeline: "shop",
			node: "staging",
			state: PromotionState.PROMOTED,
			requestedBy: "service:cd",
			requestedAt: "2026-11-01T01:00:00.000Z",
			idempotencyKey: "k1",
		}),
		create(PromotionRecordSchema, {
			schemaVersion: "hobo.cd.promotion/v1",
			promotionId: "prm-2",
			freightId: FREIGHT_ID,
			targetCampIds: ["eu-1"],
			pipeline: "shop",
			node: "prod",
			state: PromotionState.VERIFYING,
			requestedBy: "service:cd",
			requestedAt: "2026-11-01T04:00:00.000Z",
			idempotencyKey: "k2",
			fanoutId: "fan-1",
		}),
	);
	s.current["stg-1"] = create(SetRecordSchema, {
		schemaVersion: "hobo.cd.set/v1",
		setId: "set-1",
		campId: "stg-1",
		freightId: FREIGHT_ID,
		createdAt: "2026-11-01T01:30:00.000Z",
	});
	s.current["eu-1"] = create(SetRecordSchema, {
		schemaVersion: "hobo.cd.set/v1",
		setId: "set-2",
		campId: "eu-1",
		freightId: FREIGHT_ID,
		createdAt: "2026-11-01T04:30:00.000Z",
	});
	s.status["stg-1"] = create(ReconcileObservationRecordSchema, {
		campId: "stg-1",
		setId: "set-1",
		reconcilerId: "r1",
		fenceToken: "7",
		status: ReconcileStatus.CONVERGED,
		observedAt: "2026-11-01T01:40:00.000Z",
	});
	s.camps.push(
		camp("stg-1", "staging"),
		camp("eu-1", "eu"),
		camp("eu-2", "eu", { ready: false, taint: { key: "hobo.cd/unreachable", effect: TaintEffect.NO_PLACE } }),
	);
	s.decisions.push(
		create(PlacementDecisionRecordSchema, {
			decisionId: "pd-1",
			placement: "eu-fleet",
			pipeline: "shop",
			node: "prod",
			inventoryDigest: "sha256:cccc",
			groups: [create(PlacementGroupDecisionRecordSchema, { name: "pilot", index: 0, campIds: ["eu-1"], mandatory: true })],
			decidedAt: "2026-11-01T03:30:00.000Z",
		}),
	);
	s.fanoutQualified["shop/prod"] = { campIds: ["eu-1"], freightId: FREIGHT_ID };
	s.fanouts.push(
		create(FanoutStatusRecordSchema, {
			fanoutId: "fan-1",
			pipeline: "shop",
			node: "prod",
			freightId: FREIGHT_ID,
			decisionId: "pd-1",
			state: FanoutState.RUNNING,
			inFlight: ["eu-1"],
			deferred: ["eu-2"],
			updatedAt: "2026-11-01T04:00:00.000Z",
		}),
	);
	s.failovers.push(
		create(FailoverRecordSchema, {
			failoverId: "fo-1",
			pipeline: "shop",
			node: "prod",
			fromCampId: "eu-2",
			state: FailoverState.PROPOSED,
			freightId: FREIGHT_ID,
			updatedAt: "2026-11-01T05:00:00.000Z",
		}),
		create(FailoverRecordSchema, {
			failoverId: "fo-0",
			pipeline: "shop",
			node: "prod",
			fromCampId: "eu-9",
			state: FailoverState.COMPLETED,
			updatedAt: "2026-10-01T05:00:00.000Z",
		}),
	);
	s.compliance.push(
		create(ComplianceRecordSchema, {
			campId: "eu-1",
			railDigest: RAIL_DIGEST,
			candidate: true,
			state: ComplianceState.COMPLIANT,
			observationPosition: "12",
			evaluatedAt: "2026-11-01T06:00:00.000Z",
		}),
		create(ComplianceRecordSchema, {
			campId: "eu-1",
			railDigest: "sha256:dddd",
			state: ComplianceState.NONCOMPLIANT,
			observationPosition: "13",
			evaluatedAt: "2026-11-01T06:00:00.000Z",
		}),
	);
	return s;
}

/** Journal facts mirrored on the SSE stream. */
export function seedJournal(store: FakeStore): void {
	store.push(CD_STREAMS.freight(FREIGHT_ID), CD_EVENTS.FreightRecorded, { freightId: FREIGHT_ID });
	store.push(CD_STREAMS.campInventory("eu-2"), CD_EVENTS.CampTainted, { campId: "eu-2", effect: "TAINT_EFFECT_NO_PLACE" });
	store.push("yard-other", "yard.Unrelated", { x: 1 });
	store.push(CD_STREAMS.fanout("fan-1"), CD_EVENTS.FanoutProgressed, { fanoutId: "fan-1", big: 10n });
	store.push(CD_STREAMS.failover("fo-1"), CD_EVENTS.FailoverProposed, { failoverId: "fo-1" });
	store.push(CD_STREAMS.compliance("eu-1"), CD_EVENTS.ComplianceObserved, { campId: "eu-1" });
}
