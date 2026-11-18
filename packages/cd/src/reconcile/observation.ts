import { createHash } from "node:crypto";
import { clone, create } from "@bufbuild/protobuf";
import { type ResolvedDeploymentSet, toSecretFreeOutputs } from "@hobo/cloud";
import {
	CampManagement,
	type ReasonRecord,
	type ReconcileObservationRecord,
	ReconcileObservationRecordSchema,
	ReconcileStatus,
	type ResourceObservation,
} from "../_generated/cd_pb.js";
import { OBSERVE_ATTRIBUTES_LIMIT_BYTES } from "../events.js";
import { reason } from "./errors.js";
import { applyRetained, mappingRetained, mergeRetained } from "./retained.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

function bytes(text: string): number {
	return encoder.encode(text).length;
}

function truncateUtf8(text: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const encoded = encoder.encode(text);
	if (encoded.length <= maxBytes) return text;
	return decoder.decode(encoded.slice(0, maxBytes)).replace(/�+$/u, "");
}

function digest(text: string): string {
	return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function redactSecret(key: string, value: string): string | undefined {
	return toSecretFreeOutputs({ [key]: value }).secretRefs[0];
}

export type AttributeTrim = Readonly<{
	attributes: Readonly<Record<string, string>>;
	reasons: readonly ReasonRecord[];
}>;

export function trimAttributes(
	input: Readonly<{
		resource: string;
		attributes: Readonly<Record<string, string>>;
		observeFields: readonly string[];
		limitBytes?: number;
	}>,
): AttributeTrim {
	const limit = input.limitBytes ?? OBSERVE_ATTRIBUTES_LIMIT_BYTES;
	const declared = new Set(input.observeFields);
	const reasons: ReasonRecord[] = [];
	const out: Record<string, string> = {};
	const undeclared: string[] = [];
	let used = 0;
	for (const key of Object.keys(input.attributes).sort()) {
		const raw = input.attributes[key] ?? "";
		if (!declared.has(key)) {
			undeclared.push(key);
			continue;
		}
		const subject = `${input.resource}/${key}`;
		const redacted = redactSecret(key, raw);
		if (redacted !== undefined) {
			reasons.push(
				reason(
					"attribute-secret-redacted",
					`attribute ${key} looked like secret material`,
					subject,
				),
			);
		}
		const value = redacted ?? raw;
		const size = bytes(key) + bytes(value);
		if (used + size <= limit) {
			out[key] = value;
			used += size;
			continue;
		}
		const marker = `…[truncated ${digest(value)}]`;
		const room = limit - used - bytes(key) - bytes(marker);
		if (room > 0) {
			const kept = `${truncateUtf8(value, room)}${marker}`;
			out[key] = kept;
			used += bytes(key) + bytes(kept);
			reasons.push(
				reason(
					"attribute-truncated",
					`attribute ${key} (${bytes(value)} bytes) truncated to fit ${limit} bytes per resource`,
					subject,
				),
			);
		} else {
			reasons.push(
				reason(
					"attribute-dropped",
					`attribute ${key} (${bytes(value)} bytes, digest ${digest(value)}) did not fit ${limit} bytes per resource`,
					subject,
				),
			);
		}
	}
	if (undeclared.length > 0) {
		reasons.push(
			reason(
				"attribute-undeclared",
				`removed attributes outside observe_fields: ${undeclared.join(", ")}`,
				input.resource,
			),
		);
	}
	return Object.freeze({
		attributes: Object.freeze(out),
		reasons: Object.freeze(reasons),
	});
}

export type SanitizeInput = Readonly<{
	observation: ReconcileObservationRecord;
	campId: string;
	reconcilerId: string;
	fence: bigint;
	nowMs: number;
	observeFields: readonly string[];
	management: CampManagement;
	resolved?: ResolvedDeploymentSet;
}>;

export function sanitizeObservation(
	input: SanitizeInput,
): ReconcileObservationRecord {
	const observedAt = new Date(input.nowMs).toISOString();
	const next = clone(ReconcileObservationRecordSchema, input.observation);
	next.campId = input.campId;
	next.reconcilerId = input.reconcilerId;
	next.fenceToken = input.fence.toString(10);
	if (next.observedAt === "") next.observedAt = observedAt;
	const reasons: ReasonRecord[] = [...next.reasons];
	const mapping = input.resolved
		? mappingRetained(input.resolved)
		: new Map<string, readonly string[]>();
	next.resources = next.resources
		.map((resource): ResourceObservation => {
			const trimmed = trimAttributes({
				resource: resource.resource,
				attributes: resource.attributes,
				observeFields: input.observeFields,
			});
			reasons.push(...trimmed.reasons);
			const retained = mergeRetained({
				kind: resource.kind,
				component: resource.retained,
				mapping: mapping.get(resource.resource) ?? [],
			});
			const applied = applyRetained(resource, retained);
			applied.attributes = { ...trimmed.attributes };
			return applied;
		})
		.sort((a, b) => a.resource.localeCompare(b.resource));
	next.claims = next.claims.map((claim) => {
		const stamped = { ...claim };
		stamped.reportedBy = input.reconcilerId;
		if (stamped.observedAt === "") stamped.observedAt = observedAt;
		return stamped;
	});
	const handover: Record<string, string> = {};
	for (const key of Object.keys(next.handover).sort()) {
		const value = next.handover[key] ?? "";
		const redacted = redactSecret(key, value);
		if (redacted !== undefined)
			reasons.push(
				reason(
					"handover-secret-redacted",
					`handover output ${key} looked like secret material`,
					key,
				),
			);
		handover[key] = redacted ?? value;
	}
	next.handover = handover;
	const drifted = next.resources.some((resource) => resource.driftKind !== "");
	if (next.status === ReconcileStatus.DRIFTED && !drifted)
		next.status = ReconcileStatus.CONVERGED;
	if (next.status === ReconcileStatus.CONVERGED && drifted)
		next.status = ReconcileStatus.DRIFTED;
	if (input.management === CampManagement.OBSERVE_ONLY) {
		if (next.status !== ReconcileStatus.BLOCKED)
			next.status = ReconcileStatus.OBSERVED;
	}
	next.reasons = reasons;
	return next;
}

export function blockedObservation(
	input: Readonly<{
		campId: string;
		setId: string;
		reconcilerId: string;
		fence: bigint;
		nowMs: number;
		reasons: readonly ReasonRecord[];
	}>,
): ReconcileObservationRecord {
	return create(ReconcileObservationRecordSchema, {
		campId: input.campId,
		setId: input.setId,
		reconcilerId: input.reconcilerId,
		fenceToken: input.fence.toString(10),
		status: ReconcileStatus.BLOCKED,
		reasons: [...input.reasons],
		observedAt: new Date(input.nowMs).toISOString(),
	});
}

export function isConvergedOn(
	observation: ReconcileObservationRecord,
	setId: string,
): boolean {
	return (
		observation.status === ReconcileStatus.CONVERGED &&
		observation.setId === setId &&
		observation.resources.every((resource) => resource.driftKind === "")
	);
}
