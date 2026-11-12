// Shared harness for the @hobo/cd conformance suites (plan 0024 WP20).
//
// Every suite is a set of named assertions run against one subject. A check
// passes only by returning; anything else (a violation, a thrown error, a
// timeout) is a recorded failure with its detail. Absent harness capability is
// a failure too: a suite never passes on missing evidence (plan 0024 §12).

import {
	isJsonArray,
	isJsonBigInt,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonValue,
} from "../json.js";

// public-contract: suite report schema id.
export const CD_CONFORMANCE_REPORT_SCHEMA = "hobo.cd-conformance-report/v1";

// public-contract: the metric every suite run emits per assertion.
export const CD_CONFORMANCE_METRIC = "hobo.cd.conformance.assertions";

export type CdAssertionStatus = "pass" | "fail";

export type CdAssertionFailure = Readonly<{
	assertion: string;
	detail: string;
	remediation: string;
}>;

export type CdConformanceReport<A extends string> = Readonly<{
	schema: typeof CD_CONFORMANCE_REPORT_SCHEMA;
	suite: string;
	subject: string;
	assertions: Readonly<Record<A, CdAssertionStatus>>;
	failures: readonly CdAssertionFailure[];
}>;

/** Structural mirror of `TelemetrySink.metrics` from @hobo/cd ports. */
export type CdMetricPoint = Readonly<{
	name: string;
	kind: "counter" | "histogram" | "gauge";
	value: number;
	unit: string;
	atMs: number;
	attributes: Readonly<Record<string, string | number | boolean>>;
}>;

export interface CdMetricsSink {
	metrics(points: readonly CdMetricPoint[]): Promise<void>;
}

export type CdSuiteOptions = Readonly<{
	/** Optional telemetry; one counter point per assertion. */
	telemetry?: CdMetricsSink;
	/** Injected clock for metric timestamps. Defaults to 0 (no wall clock). */
	now?: () => number;
	/** Bound on any single assertion, ms. Default 10 000. */
	assertionTimeoutMs?: number;
}>;

/** A check found the subject in breach of its port contract. */
export class CdConformanceViolation extends Error {
	readonly remediation: string;
	constructor(detail: string, remediation: string) {
		super(detail);
		this.name = "CdConformanceViolation";
		this.remediation = remediation;
	}
}

/** The harness lacks a capability the assertion needs; recorded as a failure. */
export class CdHarnessGap extends Error {
	constructor(capability: string) {
		super(`harness does not provide ${capability}`);
		this.name = "CdHarnessGap";
	}
}

/** A report with at least one failure, raised by `assertCdConformance`. */
export class CdConformanceError extends Error {
	readonly failures: readonly CdAssertionFailure[];
	constructor(
		suite: string,
		subject: string,
		failures: readonly CdAssertionFailure[],
	) {
		super(
			`${suite} conformance failed for ${subject}: ${failures
				.map(
					(failure) =>
						`${failure.assertion} (${failure.detail}; ${failure.remediation})`,
				)
				.join("; ")}`,
		);
		this.name = "CdConformanceError";
		this.failures = failures;
	}
}

export function violation(detail: string, remediation: string): never {
	throw new CdConformanceViolation(detail, remediation);
}

export function check(
	condition: boolean,
	detail: string,
	remediation: string,
): void {
	if (!condition) violation(detail, remediation);
}

export function requireCapability<T>(
	value: T | undefined,
	capability: string,
): T {
	if (value === undefined) throw new CdHarnessGap(capability);
	return value;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function bounded(
	run: () => Promise<void>,
	timeoutMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new CdConformanceViolation(
						`assertion did not finish within ${timeoutMs} ms`,
						"the subject must never wedge; bound every wait",
					),
				),
			timeoutMs,
		);
	});
	try {
		await Promise.race([run(), timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function failureOf(assertion: string, error: Error): CdAssertionFailure {
	if (error instanceof CdConformanceViolation) {
		return { assertion, detail: error.message, remediation: error.remediation };
	}
	if (error instanceof CdHarnessGap) {
		return {
			assertion,
			detail: error.message,
			remediation:
				"bind the capability in the harness; a missing probe never passes",
		};
	}
	return {
		assertion,
		detail: `subject threw ${error.name}: ${error.message}`,
		remediation:
			"return a typed Outcome refusal instead of throwing across the port",
	};
}

/** Run named checks in declaration order and build the report. */
export async function runCdAssertions<A extends string>(
	suite: string,
	subject: string,
	checks: Readonly<Record<A, () => Promise<void>>>,
	options: CdSuiteOptions = {},
): Promise<CdConformanceReport<A>> {
	const timeoutMs = options.assertionTimeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = options.now ?? (() => 0);
	const assertions: Partial<Record<A, CdAssertionStatus>> = {};
	const failures: CdAssertionFailure[] = [];
	const points: CdMetricPoint[] = [];
	// SAFETY: `Object.keys` widens to string[]; the keys are exactly the record's own `A` keys.
	for (const name of Object.keys(checks) as A[]) {
		let status: CdAssertionStatus = "pass";
		try {
			await bounded(checks[name], timeoutMs);
		} catch (error) {
			status = "fail";
			failures.push(
				failureOf(
					name,
					error instanceof Error ? error : new Error(String(error)),
				),
			);
		}
		assertions[name] = status;
		points.push({
			name: CD_CONFORMANCE_METRIC,
			kind: "counter",
			value: 1,
			unit: "{assertion}",
			atMs: now(),
			attributes: { suite, subject, assertion: name, status },
		});
	}
	if (options.telemetry) await options.telemetry.metrics(points);
	return Object.freeze({
		schema: CD_CONFORMANCE_REPORT_SCHEMA,
		suite,
		subject,
		// oxlint-disable-next-line anti-slop/no-known-value-widening -- SAFETY: the loop above assigned every key of `checks`.
		assertions: Object.freeze(assertions as Record<A, CdAssertionStatus>),
		failures: Object.freeze(failures),
	});
}

export function cdReportPassed<A extends string>(
	report: CdConformanceReport<A>,
): boolean {
	return report.failures.length === 0;
}

/** Throw a CdConformanceError naming every failed assertion. */
export function assertCdConformance<A extends string>(
	report: CdConformanceReport<A>,
): void {
	if (report.failures.length > 0)
		throw new CdConformanceError(report.suite, report.subject, report.failures);
}

// ── Shared predicates ────────────────────────────────────────────────────────

export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;

// Credential shapes that must never appear in a record (I9). Mirrors the
// @hobo/cd Freight boundary; matching is a failure, never a redaction.
const SECRET_PATTERNS: readonly RegExp[] = [
	/[a-z][a-z0-9+.-]*:\/\/[^/\s:@"]+:[^/\s@"]+@/iu,
	/\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
	/\bgithub_pat_[A-Za-z0-9_]{30,}\b/u,
	/\bglpat-[A-Za-z0-9_-]{20,}\b/u,
	/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/u,
	/\bAKIA[0-9A-Z]{16}\b/u,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/u,
	/\b(?:password|secret|api[_-]?key|token)\s*[:=]\s*[A-Za-z0-9+_-]{16,}/iu,
];

function toCanonical<T>(node: T): JsonValue {
	if (node === undefined || node === null) return null;
	if (isJsonBigInt(node)) return `${node}n`;
	if (node instanceof Uint8Array)
		return `bytes:${Buffer.from(node).toString("hex")}`;
	if (node instanceof Map) {
		const out: JsonBag = {};
		for (const [key, entry] of [...node.entries()].sort(([a], [b]) =>
			String(a).localeCompare(String(b)),
		)) {
			out[String(key)] = toCanonical(entry);
		}
		return out;
	}
	if (isJsonArray(node)) return node.map((entry) => toCanonical(entry));
	if (isJsonObject(node)) {
		const out: JsonBag = {};
		for (const key of Object.keys(node).sort()) {
			const entry = node[key];
			if (entry !== undefined) out[key] = toCanonical(entry);
		}
		return out;
	}
	if (isJsonString(node) || isJsonNumber(node) || isJsonBoolean(node))
		return node;
	return null;
}

/** Canonical JSON text of a record: sorted keys, bigint and bytes rendered. */
export function canonicalText<T>(value: T): string {
	return JSON.stringify(toCanonical(value));
}

export function findSecret<T>(value: T): string | undefined {
	const text = canonicalText(value);
	const hit = SECRET_PATTERNS.find((pattern) => pattern.test(text));
	return hit ? hit.source : undefined;
}

export function checkSecretFree<T>(value: T, what: string): void {
	const hit = findSecret(value);
	check(
		hit === undefined,
		`${what} carries credential material (pattern ${hit})`,
		"records are secret-free (I9): carry a credentialRef and resolve it where the reconciler runs",
	);
}

export type CdReasonLike = Readonly<{
	code: string;
	remediation?: string;
	message?: string;
}>;

export function checkTypedRefusal(
	outcome: Readonly<{ ok: boolean; reasons?: readonly CdReasonLike[] }>,
	what: string,
	expectedCode?: string,
): void {
	check(
		!outcome.ok,
		`${what} was accepted`,
		`${what} must be refused (fail closed)`,
	);
	const reasons = outcome.reasons ?? [];
	check(
		reasons.length > 0,
		`${what} was refused without reasons`,
		"every refusal names at least one ReasonRecord",
	);
	for (const reason of reasons) {
		check(
			reason.code.length > 0,
			`${what} refusal has an empty code`,
			"every ReasonRecord has a stable code",
		);
		check(
			(reason.remediation ?? "").length > 0,
			`${what} refusal ${reason.code} has no remediation`,
			"every refusal names its next step",
		);
	}
	if (expectedCode !== undefined) {
		check(
			reasons.some((reason) => reason.code === expectedCode),
			`${what} refused with ${reasons.map((reason) => reason.code).join(",")}, not ${expectedCode}`,
			`refuse with the typed code ${expectedCode}`,
		);
	}
}

/** Deterministic permutations of `items` (rotation + reversal family), first is identity. */
export function permutationsOf<T>(
	items: readonly T[],
	count: number,
): readonly (readonly T[])[] {
	const out: T[][] = [];
	const n = items.length;
	for (
		let index = 0;
		out.length < count && index < Math.max(1, n) * 2;
		index += 1
	) {
		const rotation = n === 0 ? 0 : index % n;
		const rotated = [...items.slice(rotation), ...items.slice(0, rotation)];
		out.push(index >= n ? rotated.reverse() : rotated);
	}
	// Interleave evens then odds: a third order no rotation produces.
	if (out.length < count && n > 2) {
		out.push([
			...items.filter((_, i) => i % 2 === 0),
			...items.filter((_, i) => i % 2 === 1),
		]);
	}
	return out;
}

export function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}
