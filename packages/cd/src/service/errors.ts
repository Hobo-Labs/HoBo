// Typed failure modes of the CD service host and its read API (WP12, plan
// 0024). Every code has the HTTP status the read API answers with and a
// remediation an operator can act on. Delivery-feed codes stay with the feed.
import { create } from "@bufbuild/protobuf";
import {
	PersistenceUnavailableError,
	StorageWorkerTerminatedError,
} from "@hobo/core";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

export type ServiceFailureSpec = Readonly<{
	status: number;
	remediation: string;
}>;

// public-contract: refusal codes of `@hobo/cd/service` with HTTP status and remediation.
export const SERVICE_FAILURES = Object.freeze({
	"route-unknown": {
		status: 404,
		remediation:
			"Use a `/v1/cd/` route listed in `GET /v1/cd/openapi.json` (read API) or the feed README (agent routes).",
	},
	"method-not-allowed": {
		status: 405,
		remediation:
			"The CD read API is read-only; use GET. Mutations go through `hobo deploy` and the governed commands.",
	},
	"not-found": {
		status: 404,
		remediation:
			"Check the id or name; list the collection first (for example `GET /v1/cd/camps`).",
	},
	"query-invalid": {
		status: 400,
		remediation:
			"Fix the query parameter named in the message; the accepted values are in `GET /v1/cd/openapi.json`.",
	},
	"last-event-id-invalid": {
		status: 400,
		remediation:
			"`Last-Event-ID` (or `?after=`) must be the decimal position from a previous `id:` line; omit it to start from the beginning.",
	},
	"store-unavailable": {
		status: 503,
		remediation:
			"The journal failed; check storage health (`GET /v1/cd/ready`) and retry with backoff.",
	},
	"view-failed": {
		status: 500,
		remediation:
			"A module projection threw while building this view; the subject names the route. Check that module's runbook and the service log.",
	},
	"not-ready": {
		status: 503,
		remediation:
			"The CD service is starting, draining, or a dependency is unhealthy; read the failing checks in the body and fix the first one.",
	},
	"step-failed": {
		status: 503,
		remediation:
			"A tick step threw; read its last error in `GET /v1/cd/ready`. The step retries every tick; if it keeps failing, check the module's runbook.",
	},
	"reconciler-crashed": {
		status: 503,
		remediation:
			"A reconciler run loop exited; the service restarts it with backoff. If it keeps crashing, check the reconciler runbook (lease, store, realizer).",
	},
	"drain-deadline-exceeded": {
		status: 503,
		remediation:
			"Drain gave up at its deadline; leases not released expire after their TTL (30 s by default) and another holder resumes by observation.",
	},
	"already-started": {
		status: 409,
		remediation:
			"A service instance starts once; create a new instance to restart after a drain.",
	},
} as const satisfies Readonly<Record<string, ServiceFailureSpec>>);

export type ServiceFailureCode = keyof typeof SERVICE_FAILURES;

export function serviceReason(
	code: ServiceFailureCode,
	message: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: SERVICE_FAILURES[code].remediation,
		subject,
	});
}

export function serviceRefusal(
	code: ServiceFailureCode,
	message: string,
	subject = "",
): Refusal {
	return { ok: false, reasons: [serviceReason(code, message, subject)] };
}

/** HTTP status of a refusal: the first reason's known code, else 400. */
export function statusOf(refusal: Refusal): number {
	const code = refusal.reasons[0]?.code ?? "";
	return Object.hasOwn(SERVICE_FAILURES, code)
		? // SAFETY: Object.hasOwn proved the code is a SERVICE_FAILURES key.
			SERVICE_FAILURES[code as ServiceFailureCode].status
		: 400;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: JavaScript catch values are untrusted; only Error.message or String() is read.
export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** True when an error means the journal itself is unavailable. */
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SAFETY: JavaScript catch values are untrusted; only instanceof against the core store errors is checked.
export function isStoreFailure(error: unknown): boolean {
	return (
		error instanceof PersistenceUnavailableError ||
		error instanceof StorageWorkerTerminatedError
	);
}
