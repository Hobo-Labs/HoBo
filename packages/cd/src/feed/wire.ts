// Wire contract of the delivery feed (agent ↔ Station), shared by the
// handler (./handler.ts) and the agent transport (../agent/http-transport.ts).
// Records cross as protobuf JSON (generated schemas); envelopes, leases and
// positions are parsed once at the boundary into derived types.
import {
	fromJson,
	type JsonValue as PbJsonValue,
	toJson,
} from "@bufbuild/protobuf";
import {
	type EventPosition,
	type FenceToken,
	type JsonObject,
	parseEventPosition,
	parseFenceToken,
} from "@hobo/core";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type {
	CampId,
	Outcome,
	ReconcilerId,
	ReconcilerLease,
} from "../ports.js";
import { feedRefusal } from "./errors.js";
import { isNumber, isWireObject, text, type WireObject } from "./json.js";

// public-contract: delivery-feed routes under `/v1/cd/`.
export const FEED_ROUTES = Object.freeze({
	enrollments: "/v1/cd/enrollments",
	svidRefresh: "/v1/cd/svid/refresh",
	leases: "/v1/cd/leases",
	leaseRenew: "/v1/cd/leases/renew",
	leaseRelease: "/v1/cd/leases/release",
	feed: "/v1/cd/feed",
	blobs: "/v1/cd/blobs/",
	observations: "/v1/cd/observations",
	checkpoints: "/v1/cd/checkpoints",
} as const);

// public-contract: media types of the delivery feed.
export const FEED_MEDIA_TYPES = Object.freeze({
	json: "application/json",
	sse: "text/event-stream",
} as const);

// public-contract: request body limit of the delivery feed.
export const FEED_MAX_REQUEST_BYTES = 1_048_576 as const;

export { isWireObject, text, type WireObject } from "./json.js";

export function okBody(value: PbJsonValue): string {
	return JSON.stringify({ ok: true, value });
}

export function refusalBody(reasons: readonly ReasonRecord[]): string {
	return JSON.stringify({
		ok: false,
		reasons: reasons.map((r) => toJson(ReasonRecordSchema, r)),
	});
}

/** Parse a feed envelope (`{ok, value}` / `{ok:false, reasons}`). */
export function parseEnvelope(text: string): Outcome<PbJsonValue> {
	let json: PbJsonValue;
	try {
		json = JSON.parse(text);
	} catch {
		return feedRefusal("request-invalid", "response is not JSON");
	}
	if (!isWireObject(json))
		return feedRefusal("request-invalid", "response is not an envelope");
	if (json.ok === true) return { ok: true, value: json.value ?? null };
	const reasons = Array.isArray(json.reasons) ? json.reasons : [];
	if (reasons.length === 0)
		return feedRefusal("request-invalid", "refusal without reasons");
	try {
		return {
			ok: false,
			reasons: reasons.map((r) =>
				fromJson(ReasonRecordSchema, r, { ignoreUnknownFields: true }),
			),
		};
	} catch {
		return feedRefusal("request-invalid", "refusal reasons do not parse");
	}
}

export function leaseJson(lease: ReconcilerLease): JsonObject {
	return {
		reconcilerId: lease.reconcilerId,
		campId: lease.campId,
		holderId: lease.holderId,
		fence: lease.fence.toString(10),
		expiresAtMs: lease.expiresAtMs,
	};
}

export function parseLease(
	value: PbJsonValue | undefined,
): Outcome<ReconcilerLease> {
	if (!isWireObject(value))
		return feedRefusal("request-invalid", "lease must be an object");
	const reconcilerId = text(value.reconcilerId);
	const campId = text(value.campId);
	const holderId = text(value.holderId);
	if (!reconcilerId || !campId || !holderId)
		return feedRefusal(
			"request-invalid",
			"lease needs reconcilerId, campId and holderId",
		);
	let fence: FenceToken;
	try {
		fence = parseFenceToken(value.fence);
	} catch {
		return feedRefusal(
			"request-invalid",
			"lease fence must be a decimal string",
		);
	}
	const expiresAtMs = isNumber(value.expiresAtMs) ? value.expiresAtMs : 0;
	return {
		ok: true,
		value: Object.freeze({
			// SAFETY: non-empty ids parsed at the wire boundary; authorization checks them against the enrollment.
			reconcilerId: reconcilerId as ReconcilerId,
			// SAFETY: as above; the handler checks the Camp against the reconciler's accepted Camps.
			campId: campId as CampId,
			holderId,
			fence,
			expiresAtMs,
		}),
	};
}

export function parsePosition(
	value: PbJsonValue | undefined,
): Outcome<EventPosition> {
	try {
		return { ok: true, value: parseEventPosition(value) };
	} catch {
		return feedRefusal(
			"request-invalid",
			"position must be a non-negative decimal string",
		);
	}
}

export function parseJsonBody(body: Uint8Array): Outcome<WireObject> {
	if (body.byteLength > FEED_MAX_REQUEST_BYTES)
		return feedRefusal(
			"body-too-large",
			`body of ${body.byteLength} bytes exceeds 1 MiB`,
		);
	try {
		const json: PbJsonValue = JSON.parse(new TextDecoder().decode(body));
		if (!isWireObject(json))
			return feedRefusal("request-invalid", "body must be a JSON object");
		return { ok: true, value: json };
	} catch {
		return feedRefusal("request-invalid", "body is not JSON");
	}
}
