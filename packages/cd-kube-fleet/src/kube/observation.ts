// Shared pieces of both realizers: the preflight every pass runs before any
// hub call (I1 content check, cluster mapping, rendering) and the
// ReconcileObservationRecord builder. Nothing here performs I/O.
import { create } from "@bufbuild/protobuf";
import {
	type CdContext,
	type RealizeInput,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	type ResourceObservation,
	ResourceObservationSchema,
} from "@hobo/cd";
import type { RealizerConfig } from "../config.js";
import { KubeFleetError, reason, reasonOf } from "../errors.js";
import { type KubeObject, renderObjects } from "./objects.js";

export type Preflight =
	| Readonly<{ ok: true; cluster: string; objects: readonly KubeObject[] }>
	| Readonly<{ ok: false; reasons: readonly ReasonRecord[] }>;

/** Resources the reconciler's departure plan keeps (WP7 `keep` directive). */
export function keepOf(input: RealizeInput): ReadonlySet<string> {
	const directed: RealizeInput & Readonly<{ keep?: readonly string[] }> = input;
	return new Set(directed.keep ?? []);
}

/**
 * Everything a pass checks before touching the hub. A failure here is a
 * BLOCKED observation and zero hub calls.
 */
export function preflight(
	input: RealizeInput,
	config: RealizerConfig,
	defaultNamespace: string,
): Preflight {
	const desiredHash = input.desired.contentHash;
	if (desiredHash !== "" && desiredHash !== input.resolved.contentHash)
		return {
			ok: false,
			reasons: [
				reason(
					"resolved-set-mismatch",
					`Set ${input.desired.setId} declares ${desiredHash}; the resolved set hashes to ${input.resolved.contentHash}`,
					input.campId,
				),
			],
		};
	const cluster = config.clusters.get(input.campId);
	if (cluster === undefined)
		return {
			ok: false,
			reasons: [reason("kube-cluster-unmapped", `Camp ${input.campId} has no cluster`, input.campId)],
		};
	try {
		return { ok: true, cluster, objects: renderObjects(input.resolved, defaultNamespace) };
	} catch (error) {
		if (error instanceof KubeFleetError) return { ok: false, reasons: [reasonOf(error, input.campId)] };
		throw error;
	}
}

export function resourceObservation(
	init: Readonly<{
		object: KubeObject;
		physicalId: string;
		outputsHash: string;
		healthy: boolean;
		driftKind?: string;
		attributes?: Readonly<Record<string, string>>;
	}>,
): ResourceObservation {
	return create(ResourceObservationSchema, {
		resource: init.object.resource,
		physicalId: init.physicalId,
		outputsHash: init.outputsHash,
		healthy: init.healthy,
		driftKind: init.driftKind ?? "",
		kind: init.object.port,
		classification: init.object.classification,
		attributes: { ...init.attributes },
		retained: [],
	});
}

export function observation(
	input: RealizeInput,
	ctx: CdContext,
	status: ReconcileStatus,
	resources: readonly ResourceObservation[],
	reasons: readonly ReasonRecord[],
): ReconcileObservationRecord {
	return create(ReconcileObservationRecordSchema, {
		campId: input.campId,
		setId: input.desired.setId,
		reconcilerId: input.reconcilerId,
		fenceToken: input.fence.toString(),
		status,
		resources: [...resources],
		reasons: [...reasons],
		observedAt: new Date(ctx.now()).toISOString(),
		claims: [],
		handover: {},
	});
}

/** A BLOCKED observation for a caught error (typed failures keep their code). */
export function blocked(
	input: RealizeInput,
	ctx: CdContext,
	error: Error,
): ReconcileObservationRecord {
	return observation(input, ctx, ReconcileStatus.BLOCKED, [], [reasonOf(error, input.campId)]);
}
