// Typed failure modes of the CD composition root (WP18, plan 0024). Every
// refusal carries a stable code plus a remediation an operator or agent can
// act on; nothing here decides delivery, it only refuses to wire badly.
import { create } from "@bufbuild/protobuf";
import { type ReasonRecord, ReasonRecordSchema } from "../_generated/cd_pb.js";
import type { Refusal } from "../ports.js";

// public-contract: reason codes the compose module writes.
export const COMPOSE_FAILURES = Object.freeze({
	"compose-unbound":
		"A module was called before composition finished binding it (a dependency cycle used too early). Call it only after composeContinuousDelivery returns.",
	"compose-rebound":
		"A late-bound module was bound twice; composition binds each module exactly once. Compose a fresh ContinuousDelivery instead of re-binding.",
	"compose-scope-unbuilt":
		"An adapter builder asked for a module that is built after it. Reorder the adapter's needs or read the module lazily inside the adapter's methods.",
	"compose-realizer-missing":
		"No realizer is configured for this reconciler mode. Configure the conductor realizer (hosting/orchestrator), a publisher, or pass --simulate for the labelled fixture path.",
	"compose-store-invalid":
		"The CD store configuration is invalid. Use sqlite (default, HOBO_CD_SQLITE_PATH) or postgres (HOBO_CD_POSTGRES_URL, PostgreSQL >= 16).",
	"compose-store-multinode":
		"More than one CD replica or an agent fleet across Station processes requires Postgres (R6). Set HOBO_CD_POSTGRES_URL.",
	"compose-simulate-required":
		"The in-memory store and the simulated realizer are fixtures; they are reachable only with --simulate.",
	"compose-artifacts-invalid":
		"The artifact store configuration is invalid. Use filesystem (default under HOBO_HOME), s3-compatible with a credentialRef, or memory with --simulate.",
	"compose-runbook-unconfigured":
		"No RunbookExecutor is composed, so RUNBOOK hooks fail closed. Compose the Station runbook executor (hobo runbook) before declaring RUNBOOK hooks.",
	"compose-suite-unconfigured":
		"No VerifyPort is composed, so SUITE hooks and suite checks fail closed. Compose the verify-suite runner before declaring suites.",
	"compose-traffic-unconfigured":
		"No traffic routing is composed for this Camp, so it offers no traffic capability; a required canary is refused as progressive-unsupported. Compose Station cutover routing for the Camp's provider.",
	"compose-notify-unrouted":
		"A NOTIFY hook named a channel with no composed sink; the notification was dropped (NOTIFY is best-effort). Configure the channel's CloudEvents webhook sink.",
	"rail-delivery-invalid":
		"The Rail's `delivery` object does not parse as RailDeliveryRecord; the Rail is treated as binding no Camp sets. Republish the Rail with a valid delivery object.",
} as const);

export type ComposeFailureCode = keyof typeof COMPOSE_FAILURES;

export function composeReason(
	code: ComposeFailureCode,
	message: string,
	subject = "",
): ReasonRecord {
	return create(ReasonRecordSchema, {
		code,
		message,
		remediation: COMPOSE_FAILURES[code],
		subject,
	});
}

export function composeRefusal(
	code: ComposeFailureCode,
	message: string,
	subject = "",
): Refusal {
	return { ok: false, reasons: [composeReason(code, message, subject)] };
}

export class ComposeError extends Error {
	readonly code: ComposeFailureCode;
	readonly remediation: string;
	readonly subject: string;
	constructor(code: ComposeFailureCode, message: string, subject = "") {
		super(`${code}: ${message}`);
		this.name = "ComposeError";
		this.code = code;
		this.remediation = COMPOSE_FAILURES[code];
		this.subject = subject;
	}
	toReason(): ReasonRecord {
		return composeReason(this.code, this.message, this.subject);
	}
}
