import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
	DURABLE_MESSAGING_LIMITS,
	type DurableMessagingOperation,
	type DurableMessagingOutcome,
	type DurableMessagingRejectionCode,
	parseDurableMessagingOperation,
} from "@hobo/core";
import type { RawAccess } from "rivetkit/db";
import { synchronousResult } from "./synchronous-result.js";

// Actor-internal building block, not a messaging provider or a network boundary.
// The trusted actor and host must authenticate and pin tenant/instance
// authority through response delivery, validate and canonicalize transport
// inputs, isolate the fixed reducer from ambient effects, and fence old owners.
// The verifier must independently attest the complete executable/dependency
// closure and behavior-affecting configuration for the tenant, instance and
// generation; an arbitrary digest alone is not evidence. It must fail closed
// if that environment changes or cannot be verified, including across failover.
// The actor database is trusted, exclusive to its authenticated owner and
// independently size-limited by the host. SQL size projections alone cannot
// bound SQLite work on arbitrary corruption. This is not a tamper-proof ledger:
// valid-looking row edits and deletions cannot be detected by schema checks.
// Migration requires authenticated state transfer and fencing old owners.
// A synchronous verifier, reducer or SQLite call may block the actor thread.
// The host must provide an independent watchdog/process boundary and bounded
// transport/database inputs; the finite model tests do not prove liveness.
// Before calling this internal journal, the bounded transport must apply the
// public operation parser to reject extra, accessor-backed or malformed fields.
// This journal extracts only the two identity fields and is not that boundary.
// JavaScript function types do not enforce purity or host isolation.
const MAX_REQUEST_BYTES = 131_072;
const MAX_RECEIPT_BYTES = 262_144;
const MAX_STATE_BYTES = 4_194_304;
/** Actor-local wire/state ceilings; item-count limits alone do not imply these. */
export const RIVET_DURABLE_JOURNAL_BOUNDS = Object.freeze({
	requestBytes: MAX_REQUEST_BYTES,
	receiptBytes: MAX_RECEIPT_BYTES,
	stateBytes: MAX_STATE_BYTES,
});
const encoder = new TextEncoder();
const rejectionCodes: readonly DurableMessagingRejectionCode[] = [
	"invalid-argument",
	"unauthorized",
	"not-found",
	"unsupported",
	"operation-conflict",
	"message-conflict",
	"subscription-conflict",
	"retention-blocked",
	"lease-lost",
	"capacity-exceeded",
	"unavailable",
];
/* oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- SAFETY: heterogeneous SQLite rows are validated before use. */
type Row = Record<string, unknown>;
type Scope = { readonly tenant: string; readonly instance: string };
type AuthorityClaim = Readonly<
	Scope & {
		readonly semanticDigest: string;
		readonly method: string;
		readonly requestBase64: string;
		readonly operation: DurableMessagingOperation;
	}
>;
type Decision =
	| { readonly status: "committed"; readonly value: string }
	| {
			readonly status: "rejected";
			readonly code: DurableMessagingRejectionCode;
	  };
type Reduction =
	| {
			readonly status: "committed";
			readonly value: string;
			readonly state: string;
	  }
	| {
			readonly status: "rejected";
			readonly code: DurableMessagingRejectionCode;
	  };
type JournalInput = {
	readonly operation: DurableMessagingOperation;
	readonly scope: Scope;
	readonly method: string;
	/** Authenticated immutable digest of reducer semantics and state schema. */
	readonly semanticDigest: string;
	readonly request: Uint8Array;
};

/** Installs journal state into the same actor-local database as business state. */
export async function migrateDurableReceiptJournal(
	database: RawAccess,
): Promise<void> {
	await database.execute(
		"CREATE TABLE IF NOT EXISTS hobo_dm_receipt_clock (tenant TEXT NOT NULL, instance TEXT NOT NULL, now_ms INTEGER NOT NULL, PRIMARY KEY (tenant, instance))",
	);
	await database.execute(
		"CREATE TABLE IF NOT EXISTS hobo_dm_receipts (tenant TEXT NOT NULL, instance TEXT NOT NULL, operation_id TEXT NOT NULL, expiry INTEGER NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant, instance, operation_id))",
	);
	await database.execute(
		"CREATE TABLE IF NOT EXISTS hobo_dm_topic_state (tenant TEXT NOT NULL, instance TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (tenant, instance))",
	);
	await database.execute(
		"CREATE TABLE IF NOT EXISTS hobo_dm_semantics (tenant TEXT NOT NULL, instance TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (tenant, instance))",
	);
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: journal identifiers and persisted records cross actor and storage boundaries. */
function validString(value: unknown, max: number): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= max &&
		!/[\p{Cc}\uD800-\uDFFF]/u.test(value) &&
		encoder.encode(value).length <= max
	);
}
function scopeSnapshot(value: Scope): Scope | undefined {
	try {
		if (utilTypes.isProxy(value)) return undefined;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return undefined;
		const tenant = Object.getOwnPropertyDescriptor(value, "tenant");
		const instance = Object.getOwnPropertyDescriptor(value, "instance");
		if (
			tenant === undefined ||
			instance === undefined ||
			!Object.hasOwn(tenant, "value") ||
			!Object.hasOwn(instance, "value") ||
			!validString(tenant.value, 128) ||
			!validString(instance.value, 128)
		)
			return undefined;
		return { tenant: tenant.value, instance: instance.value };
	} catch {
		return undefined;
	}
}
function safeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function parsedDecision(status: unknown, value: unknown): Decision | undefined {
	if (
		typeof value !== "string" ||
		value.length > MAX_RECEIPT_BYTES ||
		/[\uD800-\uDFFF]/u.test(value) ||
		encoder.encode(value).length > MAX_RECEIPT_BYTES
	)
		return undefined;
	if (status === "committed") return { status, value };
	if (status === "rejected" && rejectionCodes.some((code) => code === value)) {
		// SAFETY: membership in the frozen finite rejection vocabulary was checked.
		return { status, code: value as DurableMessagingRejectionCode };
	}
	return undefined;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

/**
 * Serialize a state transition and its receipt in one transaction. The fixed,
 * trusted actor reducer is synchronous and receives no database capability;
 * its state and decision are captured before any further database await.
 * Actor code and its host must prohibit ambient or detached effects separately.
 * Any transaction or reducer failure returns unknown. Callers must separately
 * validate returned receipt contents at the transport boundary.
 */
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: persisted SQLite rows and reducer outputs are validated before use. */
export async function runDurableReceiptJournal(
	database: RawAccess,
	input: JournalInput,
	now: () => number,
	authorized: (claim: AuthorityClaim) => boolean,
	execute: (
		state: string | undefined,
		timestamp: number,
		requestBase64: string,
	) => Reduction,
): Promise<DurableMessagingOutcome<string>> {
	let operation: DurableMessagingOperation;
	if (utilTypes.isProxy(input))
		throw new TypeError("proxy input is unsupported");
	const descriptor = Object.getOwnPropertyDescriptor(input, "operation");
	if (descriptor === undefined || !Object.hasOwn(descriptor, "value"))
		throw new TypeError("operation must be an own data property");
	try {
		const raw = descriptor.value;
		if (raw === null || typeof raw !== "object" || utilTypes.isProxy(raw))
			throw new TypeError("invalid operation");
		const rawPrototype = Object.getPrototypeOf(raw);
		if (
			Array.isArray(raw) ||
			(rawPrototype !== Object.prototype && rawPrototype !== null)
		)
			throw new TypeError("invalid operation");
		const id = Object.getOwnPropertyDescriptor(raw, "id");
		const expiry = Object.getOwnPropertyDescriptor(raw, "expiresAtMs");
		if (
			id === undefined ||
			expiry === undefined ||
			!Object.hasOwn(id, "value") ||
			!Object.hasOwn(expiry, "value") ||
			!id.enumerable ||
			!expiry.enumerable ||
			typeof id.value !== "string" ||
			id.value.length > 84
		)
			throw new TypeError("invalid operation");
		operation = parseDurableMessagingOperation({
			id: id.value,
			expiresAtMs: expiry.value,
		});
	} catch {
		throw new TypeError("invalid operation envelope");
	}
	const uncertain = (): DurableMessagingOutcome<string> => ({
		status: "unknown",
		operation,
	});
	let scope: Scope | undefined;
	let fingerprint: string;
	let requestBase64: string;
	let pinnedSemanticDigest: string;
	let authority: AuthorityClaim;
	try {
		const prototype = Object.getPrototypeOf(input);
		if (prototype !== Object.prototype && prototype !== null)
			return uncertain();
		const operationField = Object.getOwnPropertyDescriptor(input, "operation");
		const scopeField = Object.getOwnPropertyDescriptor(input, "scope");
		const methodField = Object.getOwnPropertyDescriptor(input, "method");
		const requestField = Object.getOwnPropertyDescriptor(input, "request");
		const semanticField = Object.getOwnPropertyDescriptor(
			input,
			"semanticDigest",
		);
		if (
			operationField === undefined ||
			!Object.hasOwn(operationField, "value") ||
			operationField.value !== descriptor.value ||
			scopeField === undefined ||
			!Object.hasOwn(scopeField, "value") ||
			methodField === undefined ||
			!Object.hasOwn(methodField, "value") ||
			requestField === undefined ||
			!Object.hasOwn(requestField, "value") ||
			semanticField === undefined ||
			!Object.hasOwn(semanticField, "value")
		)
			return uncertain();
		scope = scopeSnapshot(scopeField.value);
		const method = methodField.value;
		const semanticDigest = semanticField.value;
		const bytes = requestField.value;
		if (
			scope === undefined ||
			!validString(method, 64) ||
			utilTypes.isProxy(bytes) ||
			!(bytes instanceof Uint8Array) ||
			typeof semanticDigest !== "string" ||
			!/^sha256:[0-9a-f]{64}$/u.test(semanticDigest) ||
			Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
			Object.hasOwn(bytes, "buffer") ||
			Object.hasOwn(bytes, "byteLength") ||
			bytes.buffer instanceof SharedArrayBuffer ||
			bytes.byteLength > MAX_REQUEST_BYTES
		)
			return uncertain();
		const request = new Uint8Array(bytes);
		requestBase64 = Buffer.from(request).toString("base64");
		fingerprint = createHash("sha256")
			.update(
				JSON.stringify([
					scope.tenant,
					scope.instance,
					semanticDigest,
					method,
					request.length,
				]),
			)
			.update(request)
			.digest("hex");
		authority = Object.freeze({
			...scope,
			semanticDigest,
			method,
			requestBase64,
			operation,
		});
		if (synchronousResult(authorized(authority)) !== true) return uncertain();
		// The host supplies the digest independently of the client and keeps the
		// corresponding source and reducer fenced for this actor generation.
		pinnedSemanticDigest = semanticDigest;
	} catch {
		return uncertain();
	}
	const { tenant, instance } = scope;
	try {
		const outcome = await database.transaction<DurableMessagingOutcome<string>>(
			async (tx) => {
				const pins = await tx.execute<Row>(
					"SELECT CASE WHEN length(CAST(digest AS BLOB))=71 THEN digest ELSE NULL END AS digest FROM hobo_dm_semantics WHERE tenant=? AND instance=?",
					tenant,
					instance,
				);
				if (pins.length > 1) throw new Error("duplicate semantic pin");
				if (pins.length === 0) {
					const occupied = await tx.execute<Row>(
						"SELECT (EXISTS(SELECT 1 FROM hobo_dm_receipt_clock WHERE tenant=? AND instance=?) OR EXISTS(SELECT 1 FROM hobo_dm_topic_state WHERE tenant=? AND instance=?) OR EXISTS(SELECT 1 FROM hobo_dm_receipts WHERE tenant=? AND instance=?)) AS present",
						tenant,
						instance,
						tenant,
						instance,
						tenant,
						instance,
					);
					if (occupied.length !== 1 || occupied[0]?.present !== 0)
						throw new Error("unowned prior state");
					await tx.execute(
						"INSERT INTO hobo_dm_semantics(tenant,instance,digest) VALUES(?,?,?)",
						tenant,
						instance,
						pinnedSemanticDigest,
					);
				} else if (pins[0]?.digest !== pinnedSemanticDigest)
					throw new Error("semantic pin mismatch");
				const timestamp = synchronousResult(now());
				if (!safeInteger(timestamp)) throw new Error("invalid clock");
				const clocks = await tx.execute<Row>(
					"SELECT CASE WHEN typeof(now_ms)='integer' AND now_ms>=0 AND now_ms<=9007199254740991 THEN now_ms ELSE NULL END AS now_ms FROM hobo_dm_receipt_clock WHERE tenant=? AND instance=?",
					tenant,
					instance,
				);
				if (
					clocks.length > 1 ||
					(clocks[0] !== undefined &&
						(!safeInteger(clocks[0].now_ms) || clocks[0].now_ms > timestamp))
				)
					throw new Error("clock regressed");
				await tx.execute(
					"INSERT INTO hobo_dm_receipt_clock(tenant,instance,now_ms) VALUES(?,?,?) ON CONFLICT(tenant,instance) DO UPDATE SET now_ms=excluded.now_ms",
					tenant,
					instance,
					timestamp,
				);
				if (timestamp >= operation.expiresAtMs)
					return { status: "expired", operation };
				const rows = await tx.execute<Row>(
					"SELECT CASE WHEN length(CAST(fingerprint AS BLOB))<=64 THEN fingerprint ELSE NULL END AS fingerprint, CASE WHEN length(CAST(status AS BLOB))<=16 THEN status ELSE NULL END AS status, CASE WHEN length(CAST(value AS BLOB))<=262144 THEN value ELSE NULL END AS value, CASE WHEN typeof(expiry)='integer' AND expiry>=0 AND expiry<=9007199254740991 THEN expiry ELSE NULL END AS expiry FROM hobo_dm_receipts WHERE tenant=? AND instance=? AND operation_id=?",
					tenant,
					instance,
					operation.id,
				);
				if (rows.length > 1) throw new Error("duplicate receipt");
				const prior = rows[0];
				if (prior !== undefined) {
					const parsed = parsedDecision(prior.status, prior.value);
					if (
						parsed === undefined ||
						(parsed.status === "rejected" &&
							parsed.code === "operation-conflict") ||
						typeof prior.fingerprint !== "string" ||
						!/^[0-9a-f]{64}$/u.test(prior.fingerprint) ||
						prior.expiry !== operation.expiresAtMs
					)
						throw new Error("invalid receipt");
					if (prior.fingerprint !== fingerprint)
						return { status: "rejected", code: "operation-conflict" };
					return parsed;
				}
				if (
					operation.expiresAtMs - timestamp >
					DURABLE_MESSAGING_LIMITS.operationWindowMs
				)
					return uncertain();
				const expired = await tx.execute<Row>(
					"SELECT CASE WHEN length(CAST(operation_id AS BLOB))<=84 THEN operation_id ELSE NULL END AS operation_id, CASE WHEN typeof(expiry)='integer' AND expiry>=0 AND expiry<=9007199254740991 THEN expiry ELSE NULL END AS expiry FROM hobo_dm_receipts WHERE tenant=? AND instance=? AND expiry<=? LIMIT ?",
					tenant,
					instance,
					timestamp,
					DURABLE_MESSAGING_LIMITS.retainedReceipts + 1,
				);
				if (expired.length > DURABLE_MESSAGING_LIMITS.retainedReceipts)
					throw new Error("invalid receipt count");
				for (const row of expired) {
					if (
						typeof row.operation_id !== "string" ||
						row.operation_id.length > 84 ||
						!safeInteger(row.expiry)
					)
						throw new Error("invalid expiry metadata");
					parseDurableMessagingOperation({
						id: row.operation_id,
						expiresAtMs: row.expiry,
					});
				}
				await tx.execute(
					"DELETE FROM hobo_dm_receipts WHERE tenant=? AND instance=? AND expiry<=?",
					tenant,
					instance,
					timestamp,
				);
				const counts = await tx.execute<Row>(
					"SELECT count(*) AS count FROM hobo_dm_receipts WHERE tenant=? AND instance=?",
					tenant,
					instance,
				);
				if (counts.length !== 1 || !safeInteger(counts[0]?.count))
					throw new Error("invalid receipt count");
				if (counts[0].count >= DURABLE_MESSAGING_LIMITS.retainedReceipts)
					return uncertain();
				const stateRows = await tx.execute<Row>(
					"SELECT CASE WHEN length(CAST(value AS BLOB))<=4194304 THEN value ELSE NULL END AS value FROM hobo_dm_topic_state WHERE tenant=? AND instance=?",
					tenant,
					instance,
				);
				if (stateRows.length > 1) throw new Error("duplicate state");
				let priorState: string | undefined;
				if (stateRows.length > 0) {
					const stored = stateRows[0]?.value;
					if (
						typeof stored !== "string" ||
						stored.length > MAX_STATE_BYTES ||
						/[\uD800-\uDFFF]/u.test(stored) ||
						encoder.encode(stored).length > MAX_STATE_BYTES
					)
						throw new Error("invalid state");
					priorState = stored;
				}
				const decision = synchronousResult(execute(priorState, timestamp, requestBase64));
				if (
					decision === null ||
					typeof decision !== "object" ||
					utilTypes.isProxy(decision)
				)
					throw new Error("invalid reduction");
				const statusField = Object.getOwnPropertyDescriptor(decision, "status");
				const valueField = Object.getOwnPropertyDescriptor(decision, "value");
				const codeField = Object.getOwnPropertyDescriptor(decision, "code");
				const stateField = Object.getOwnPropertyDescriptor(decision, "state");
				if (statusField === undefined || !Object.hasOwn(statusField, "value"))
					throw new Error("invalid reduction");
				const value =
					statusField.value === "committed" ? valueField : codeField;
				if (value === undefined || !Object.hasOwn(value, "value"))
					throw new Error("invalid reduction");
				let parsed =
					statusField.value === "committed" &&
					typeof value.value === "string" &&
					(value.value.length > MAX_RECEIPT_BYTES ||
						encoder.encode(value.value).length > MAX_RECEIPT_BYTES)
						? {
								status: "rejected" as const,
								code: "capacity-exceeded" as const,
							}
						: parsedDecision(statusField.value, value.value);
				if (
					parsed === undefined ||
					(parsed.status === "rejected" && parsed.code === "operation-conflict")
				)
					throw new Error("invalid decision");
				if (parsed.status === "committed") {
					if (
						stateField === undefined ||
						!Object.hasOwn(stateField, "value") ||
						typeof stateField.value !== "string"
					)
						throw new Error("invalid new state");
					const nextState = stateField.value;
					if (
						nextState.length <= MAX_STATE_BYTES &&
						/[\uD800-\uDFFF]/u.test(nextState)
					)
						throw new Error("invalid state encoding");
					if (
						nextState.length > MAX_STATE_BYTES ||
						encoder.encode(nextState).length > MAX_STATE_BYTES
					)
						parsed = { status: "rejected", code: "capacity-exceeded" };
					else
						await tx.execute(
							"INSERT INTO hobo_dm_topic_state(tenant,instance,value) VALUES(?,?,?) ON CONFLICT(tenant,instance) DO UPDATE SET value=excluded.value",
							tenant,
							instance,
							nextState,
						);
				}
				await tx.execute(
					"INSERT INTO hobo_dm_receipts(tenant,instance,operation_id,expiry,fingerprint,status,value) VALUES(?,?,?,?,?,?,?)",
					tenant,
					instance,
					operation.id,
					operation.expiresAtMs,
					fingerprint,
					parsed.status,
					parsed.status === "committed" ? parsed.value : parsed.code,
				);
				return parsed;
			},
		);
		return synchronousResult(authorized(authority)) === true ? outcome : uncertain();
	} catch {
		return uncertain();
	}
}
/* oxlint-enable anti-slop/no-runtime-typeof */
