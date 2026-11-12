// Status event mapping (D5). Every report lands on the Camp's status stream
// `cd-camp-status-<id>`, never on its spec stream, so observations under
// heavy apply load can never contend with desired-state writes. One pure
// mapping is shared by every transport (in-process here, HTTP in ./feed):
//   CONVERGING                 deployment.ReconcileStarted
//   every observation          deployment.StatusObserved
//   CONVERGED                  deployment.Converged
//   BLOCKED                    deployment.ReconcileBlocked
//   reason drift-detected      resource.DriftDetected
//   reason drift-proposed      drift.DiffProposed
//   reason departure-orphaned  camp.Departed
import { fromJson, type JsonValue, toJson } from "@bufbuild/protobuf";
import type { EventInput, JsonObject } from "@hobo/core";
import {
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
} from "../_generated/cd_pb.js";
import { CD_EVENTS } from "../events.js";
import { driftFindings } from "./drift.js";

// public-contract: drift event names WP7 appends to the Camp status stream.
// Plan 0024 names them (§9 WP7) but CD_EVENTS does not list them; reported
// to the coordinator as a contract amendment candidate.
export const RECONCILE_EVENTS = Object.freeze({
	DriftDetected: "resource.DriftDetected",
	DiffProposed: "drift.DiffProposed",
} as const);

// public-contract: schema id of reconcile status event bodies.
export const RECONCILE_STATUS_SCHEMA = "hobo.cd.reconcile-status/v1" as const;

export type StatusEventType =
	| typeof CD_EVENTS.ReconcileStarted
	| typeof CD_EVENTS.StatusObserved
	| typeof CD_EVENTS.Converged
	| typeof CD_EVENTS.ReconcileBlocked
	| typeof CD_EVENTS.CampDeparted
	| (typeof RECONCILE_EVENTS)[keyof typeof RECONCILE_EVENTS];

export function observationJson(
	observation: ReconcileObservationRecord,
): JsonObject {
	const json = toJson(ReconcileObservationRecordSchema, observation);
	// SAFETY: toJson of a message is always a JSON object.
	return json as JsonObject;
}

export function parseObservation(data: JsonValue): ReconcileObservationRecord {
	return fromJson(ReconcileObservationRecordSchema, data);
}

function has(observation: ReconcileObservationRecord, code: string): boolean {
	return observation.reasons.some((r) => r.code === code);
}

/** The status-stream events one observation produces, in order. */
export function statusEventsFor(
	observation: ReconcileObservationRecord,
	idempotencyPrefix: string,
): readonly EventInput[] {
	const body = observationJson(observation);
	const types: StatusEventType[] = [];
	if (observation.status === ReconcileStatus.CONVERGING)
		types.push(CD_EVENTS.ReconcileStarted);
	types.push(CD_EVENTS.StatusObserved);
	if (has(observation, "drift-detected"))
		types.push(RECONCILE_EVENTS.DriftDetected);
	if (has(observation, "drift-proposed"))
		types.push(RECONCILE_EVENTS.DiffProposed);
	if (has(observation, "departure-orphaned"))
		types.push(CD_EVENTS.CampDeparted);
	if (observation.status === ReconcileStatus.CONVERGED)
		types.push(CD_EVENTS.Converged);
	if (observation.status === ReconcileStatus.BLOCKED)
		types.push(CD_EVENTS.ReconcileBlocked);
	return Object.freeze(
		types.map((type) => {
			const data: { [key: string]: JsonObject[string] } = {
				schema: RECONCILE_STATUS_SCHEMA,
				observation: body,
			};
			if (
				type === RECONCILE_EVENTS.DriftDetected ||
				type === RECONCILE_EVENTS.DiffProposed
			) {
				data.drift = driftFindings(observation).map((f) => ({
					resource: f.resource,
					driftClass: f.driftClass,
					fields: [...f.fields],
					outputsHash: f.outputsHash,
				}));
			}
			if (type === CD_EVENTS.CampDeparted) {
				data.orphans = observation.reasons
					.filter((r) => r.code === "departure-orphaned")
					.map((r) => r.subject);
			}
			return {
				type,
				data,
				meta: { idempotencyKey: `${idempotencyPrefix}:${type}` },
			};
		}),
	);
}
