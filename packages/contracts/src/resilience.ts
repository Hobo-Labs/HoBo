/**
 * Visible secondary Resiliency layer (ADR-0136).
 * Polly-inspired strategies as metadata + thin fact-emitting applicator.
 * Fully aligned with docs/design/dx-sdk-resilience-semantics.md:
 * - deterministic retry schedules only
 * - never retry policy.Decided deny or typed terminal failures
 * - inspection from persisted facts, never process memory
 * No Effect-TS / Polly / XState public dependencies.
 */

import type { EffectSpec } from "./effects.js";
import { requiresNetwork } from "./effects.js";
import {
	cloneAsJson,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

// public-contract: schema version for ResilienceProfile declarations (ADR-0136).
export const RESILIENCE_PROFILE_SCHEMA_VERSION = "hobo.resilience-profile/v1";

export const RESILIENCE_STRATEGY_KINDS = Object.freeze([
	"retry",
	"circuitBreaker",
	"timeout",
	"bulkhead",
	"fallback",
	"hedging",
] as const);

export type ResilienceStrategyKind = (typeof RESILIENCE_STRATEGY_KINDS)[number];

export interface DeterministicRetryStrategy {
	readonly kind: "retry";
	/** Stable seed for deterministic schedule (replay-safe). */
	readonly seed: string;
	readonly maxAttempts: number;
	readonly baseDelayMs: number;
	readonly maxDelayMs: number;
	/** Transient-only classifier label; policy.Decided / terminal never retry. */
	readonly retryOn: "transient-only";
}

export interface CircuitBreakerStrategy {
	readonly kind: "circuitBreaker";
	readonly failureThreshold: number;
	readonly resetTimeoutMs: number;
	readonly halfOpenMaxCalls: number;
}

export interface TimeoutStrategy {
	readonly kind: "timeout";
	readonly deadlineMs: number;
}

export interface BulkheadStrategy {
	readonly kind: "bulkhead";
	readonly maxConcurrent: number;
	readonly maxQueue: number;
}

export interface FallbackStrategy {
	readonly kind: "fallback";
	readonly fallbackRef: string;
}

export interface HedgingStrategy {
	readonly kind: "hedging";
	readonly delayMs: number;
	readonly maxHedges: number;
}

export type ResilienceStrategy =
	| DeterministicRetryStrategy
	| CircuitBreakerStrategy
	| TimeoutStrategy
	| BulkheadStrategy
	| FallbackStrategy
	| HedgingStrategy;

// ADR-0136 parse-don't-validate resilience DSL surface (refined readonly
// strategies); generated contracts_pb.ts ResilienceProfile is the wire form.
// domain-view: deliberate refined domain type, permanent by design.
export interface ResilienceProfile {
	readonly schemaVersion: typeof RESILIENCE_PROFILE_SCHEMA_VERSION;
	readonly id: string;
	readonly strategies: readonly ResilienceStrategy[];
	/**
	 * Explicit never-retry classes (always enforced even if strategies omit them).
	 * Matches dx-sdk-resilience-semantics.md HOBO-516 vectors.
	 */
	readonly neverRetry: readonly (
		| "policy.Decided"
		| "terminal"
		| "cancellation"
	)[];
}

export class ResilienceValidationError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(`${code}: ${message}`);
		this.name = "ResilienceValidationError";
		this.code = code;
	}
}

export function parseResilienceProfile<T>(input: T): ResilienceProfile {
	if (input === undefined || input === null) {
		throw new ResilienceValidationError(
			"missing-profile",
			"resilience profile is required when parsing",
		);
	}
	const source = expectObject(cloneAsJson(input), "resilience");
	const id = nonEmpty(source.id, "id");
	const strategiesRaw = source.strategies;
	if (!Array.isArray(strategiesRaw) || strategiesRaw.length === 0) {
		throw new ResilienceValidationError(
			"strategies-required",
			"at least one strategy required",
		);
	}
	const strategies = strategiesRaw.map((s, i) => parseStrategy(s, i));
	const neverRetry = parseNeverRetry(source.neverRetry);
	return Object.freeze({
		schemaVersion: RESILIENCE_PROFILE_SCHEMA_VERSION,
		id,
		strategies: Object.freeze(strategies),
		neverRetry: Object.freeze(neverRetry),
	});
}

export function createResilienceProfile(
	input: Partial<{
		id: string;
		strategies: ResilienceStrategy[];
		neverRetry: Array<"policy.Decided" | "terminal" | "cancellation">;
	}> = {},
): ResilienceProfile {
	return parseResilienceProfile({
		id: input.id ?? "default-resilience",
		strategies: input.strategies ?? [
			{
				kind: "retry",
				seed: "hobo-resilience-seed",
				maxAttempts: 3,
				baseDelayMs: 10,
				maxDelayMs: 100,
				retryOn: "transient-only",
			},
		],
		neverRetry: input.neverRetry ?? [
			"policy.Decided",
			"terminal",
			"cancellation",
		],
	});
}

/**
 * Circuit-breaker / hedging strategies require network or externalCall domain
 * effects. Pure contracts may still carry timeout/retry metadata for local
 * pure work units, but cannot declare circuit-breaker/hedging without I/O domains.
 */
export function validateResilienceAgainstEffects(
	profile: ResilienceProfile,
	effects: EffectSpec,
): void {
	const needsNetwork = profile.strategies.some(
		(s) => s.kind === "circuitBreaker" || s.kind === "hedging",
	);
	if (needsNetwork && !requiresNetwork(effects)) {
		throw new ResilienceValidationError(
			"resilience-requires-effects",
			"circuitBreaker/hedging strategies require network or externalCall domain effects",
		);
	}
}

// ── Failure classification (never-retry rules) ──────────────────────────────

export type FailureClass =
	| "transient"
	| "policy.Decided"
	| "terminal"
	| "cancellation"
	| "deadline";

export interface ResilienceAttemptFact {
	readonly type: "resilience.Attempt";
	readonly profileId: string;
	readonly attempt: number;
	readonly delayMs: number;
	readonly seed: string;
	readonly failureClass: FailureClass;
	readonly retried: boolean;
	readonly reason: string;
	readonly at: string;
}

export interface ResilienceTerminalFact {
	readonly type: "resilience.Terminal";
	readonly profileId: string;
	readonly failureClass: FailureClass;
	readonly attempts: number;
	readonly reason: string;
	readonly at: string;
}

export type ResilienceFact = ResilienceAttemptFact | ResilienceTerminalFact;

export interface ResilienceApplyResult<T> {
	readonly ok: boolean;
	readonly value?: T;
	readonly failureClass?: FailureClass;
	readonly facts: readonly ResilienceFact[];
	readonly attempts: number;
}

export interface ResilienceOpError {
	readonly failureClass: FailureClass;
	readonly message: string;
}

/**
 * Thin deterministic applicator. Emits attempt/terminal facts; never retries
 * policy.Decided, terminal, or cancellation. Replay reconstructs from facts —
 * do not re-run the op when replaying facts.
 */
export function applyResilienceProfile<T>(input: {
	profile: ResilienceProfile;
	/** Stable clock for facts (tests inject). */
	now?: () => string;
	/**
	 * Operation that may throw ResilienceOpError-shaped failures or return T.
	 * Transient failures may be retried under the deterministic schedule.
	 */
	op: (attempt: number) => T | Promise<T>;
}): Promise<ResilienceApplyResult<T>> {
	const profile = input.profile;
	const now = input.now ?? (() => new Date().toISOString());
	const retry = profile.strategies.find(
		(s): s is DeterministicRetryStrategy => s.kind === "retry",
	);
	const maxAttempts = retry?.maxAttempts ?? 1;
	const seed = retry?.seed ?? "no-retry";
	const facts: ResilienceFact[] = [];

	return (async () => {
		let attempts = 0;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			attempts = attempt;
			try {
				const value = await input.op(attempt);
				return { ok: true, value, facts, attempts };
			} catch (err) {
				const failure = classifyError(err);
				const delayMs = retry ? computeDelay(retry, attempt) : 0;
				const never =
					profile.neverRetry.includes(
						// SAFETY: assertion required at this I/O or test boundary.
						failure.failureClass as
							| "policy.Decided"
							| "terminal"
							| "cancellation",
					) ||
					failure.failureClass === "policy.Decided" ||
					failure.failureClass === "terminal" ||
					failure.failureClass === "cancellation";

				const retried = !never && attempt < maxAttempts && !!retry;
				facts.push({
					type: "resilience.Attempt",
					profileId: profile.id,
					attempt,
					delayMs: retried ? delayMs : 0,
					seed,
					failureClass: failure.failureClass,
					retried,
					reason: failure.message,
					at: now(),
				});

				if (!retried) {
					facts.push({
						type: "resilience.Terminal",
						profileId: profile.id,
						failureClass: failure.failureClass,
						attempts,
						reason: failure.message,
						at: now(),
					});
					return {
						ok: false,
						failureClass: failure.failureClass,
						facts,
						attempts,
					};
				}
				// Deterministic delay is recorded as a fact; tests assert schedule
				// without sleeping wall-clock for pure unit speed.
			}
		}
		facts.push({
			type: "resilience.Terminal",
			profileId: profile.id,
			failureClass: "transient",
			attempts,
			reason: "budget exhausted",
			at: now(),
		});
		return { ok: false, failureClass: "transient", facts, attempts };
	})();
}

export interface ResilienceInspection {
	readonly attempts: number;
	readonly terminal?: ResilienceTerminalFact;
	readonly retried: boolean;
}

/** Reconstruct terminal state from facts without re-running effects. */
export function inspectResilienceFromFacts(
	facts: readonly ResilienceFact[],
): ResilienceInspection {
	const attempts = facts.filter((f) => f.type === "resilience.Attempt").length;
	const terminal = facts.find(
		(f): f is ResilienceTerminalFact => f.type === "resilience.Terminal",
	);
	const retried = facts.some(
		(f) => f.type === "resilience.Attempt" && f.retried,
	);
	return { attempts, terminal, retried };
}

interface ClassifiedFailure {
	readonly failureClass: FailureClass;
	readonly message: string;
}

interface FailureFields {
	readonly failureClass?: string;
	readonly code?: string;
	readonly message?: string;
	readonly name?: string;
}

type ThrownFailure = Error | JsonValue;

function failureFields(err: ThrownFailure): FailureFields {
	const object = isJsonObject(err) ? err : undefined;
	const error = err instanceof Error ? err : undefined;
	return {
		failureClass:
			object && isJsonString(object.failureClass)
				? object.failureClass
				: undefined,
		code: object && isJsonString(object.code) ? object.code : undefined,
		message:
			error?.message ??
			(object && isJsonString(object.message) ? object.message : undefined),
		name:
			error?.name ??
			(object && isJsonString(object.name) ? object.name : undefined),
	};
}

function classifyError(err: ThrownFailure): ClassifiedFailure {
	const e = failureFields(err);
	if (
		e.failureClass === "policy.Decided" ||
		e.code === "policy-denied" ||
		e.name === "PolicyDeniedError"
	) {
		return {
			failureClass: "policy.Decided",
			message: e.message ?? "policy.Decided deny",
		};
	}
	if (
		e.failureClass === "terminal" ||
		e.code === "TERMINAL" ||
		e.name === "TerminalError"
	) {
		return {
			failureClass: "terminal",
			message: e.message ?? "terminal failure",
		};
	}
	if (
		e.failureClass === "cancellation" ||
		e.code === "CANCELLED" ||
		e.name === "CancellationError"
	) {
		return {
			failureClass: "cancellation",
			message: e.message ?? "cancelled",
		};
	}
	if (e.failureClass === "deadline" || e.code === "DEADLINE") {
		return {
			failureClass: "deadline",
			message: e.message ?? "deadline",
		};
	}
	if (e.failureClass === "transient") {
		return {
			failureClass: "transient",
			message: e.message ?? "transient",
		};
	}
	return { failureClass: "terminal", message: e.message ?? `${err}` };
}

/** Deterministic delay from seed + attempt (no wall-clock sleep required for unit tests). */
export function computeDelay(
	retry: DeterministicRetryStrategy,
	attempt: number,
): number {
	let h = 0;
	const key = `${retry.seed}:${attempt}`;
	for (let i = 0; i < key.length; i++) {
		h = (Math.imul(31, h) + key.charCodeAt(i)) | 0;
	}
	const jitter = Math.abs(h) % Math.max(1, retry.baseDelayMs);
	const exp = Math.min(
		retry.maxDelayMs,
		retry.baseDelayMs * 2 ** Math.max(0, attempt - 1) + jitter,
	);
	return Math.min(retry.maxDelayMs, exp);
}

function parseStrategy(input: JsonValue, index: number): ResilienceStrategy {
	const s = expectObject(input, `strategies[${index}]`);
	const kind = nonEmpty(s.kind, "kind");
	switch (kind) {
		case "retry":
			return Object.freeze({
				kind: "retry",
				seed: nonEmpty(s.seed, "seed"),
				maxAttempts: positiveInt(s.maxAttempts, "maxAttempts"),
				baseDelayMs: nonNegInt(s.baseDelayMs, "baseDelayMs"),
				maxDelayMs: nonNegInt(s.maxDelayMs, "maxDelayMs"),
				retryOn: "transient-only",
			});
		case "circuitBreaker":
			return Object.freeze({
				kind: "circuitBreaker",
				failureThreshold: positiveInt(s.failureThreshold, "failureThreshold"),
				resetTimeoutMs: nonNegInt(s.resetTimeoutMs, "resetTimeoutMs"),
				halfOpenMaxCalls: positiveInt(s.halfOpenMaxCalls, "halfOpenMaxCalls"),
			});
		case "timeout":
			return Object.freeze({
				kind: "timeout",
				deadlineMs: positiveInt(s.deadlineMs, "deadlineMs"),
			});
		case "bulkhead":
			return Object.freeze({
				kind: "bulkhead",
				maxConcurrent: positiveInt(s.maxConcurrent, "maxConcurrent"),
				maxQueue: nonNegInt(s.maxQueue, "maxQueue"),
			});
		case "fallback":
			return Object.freeze({
				kind: "fallback",
				fallbackRef: nonEmpty(s.fallbackRef, "fallbackRef"),
			});
		case "hedging":
			return Object.freeze({
				kind: "hedging",
				delayMs: nonNegInt(s.delayMs, "delayMs"),
				maxHedges: positiveInt(s.maxHedges, "maxHedges"),
			});
		default:
			throw new ResilienceValidationError(
				"unknown-strategy",
				`unknown strategy kind: ${kind}`,
			);
	}
}

function parseNeverRetry(
	input: JsonValue,
): Array<"policy.Decided" | "terminal" | "cancellation"> {
	const defaults: Array<"policy.Decided" | "terminal" | "cancellation"> = [
		"policy.Decided",
		"terminal",
		"cancellation",
	];
	if (input === undefined) return defaults;
	if (!Array.isArray(input)) {
		throw new ResilienceValidationError(
			"never-retry-array",
			"neverRetry must be an array",
		);
	}
	const allowed = new Set(["policy.Decided", "terminal", "cancellation"]);
	const out: Array<"policy.Decided" | "terminal" | "cancellation"> = [];
	for (const v of input) {
		if (!isJsonString(v) || !allowed.has(v)) {
			throw new ResilienceValidationError(
				"never-retry-value",
				`invalid neverRetry entry: ${String(v)}`,
			);
		}
		// SAFETY: assertion required at this I/O or test boundary.
		out.push(v as "policy.Decided" | "terminal" | "cancellation");
	}
	// Always enforce the three classes at minimum
	for (const d of defaults) {
		if (!out.includes(d)) out.push(d);
	}
	return out;
}

function expectObject(input: JsonValue, _label: string): JsonObject {
	if (input === null || !isJsonObject(input) || Array.isArray(input)) {
		throw new ResilienceValidationError("expected-object", "expected object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return input as JsonObject;
}

function nonEmpty(input: JsonValue, field: string): string {
	if (!isJsonString(input) || input.trim() === "") {
		throw new ResilienceValidationError(
			"expected-string",
			`${field} must be non-empty`,
		);
	}
	return input;
}

function positiveInt(input: JsonValue, field: string): number {
	// SAFETY: assertion required at this I/O or test boundary.
	if (!Number.isSafeInteger(input) || (input as number) <= 0) {
		throw new ResilienceValidationError(
			"expected-positive-int",
			`${field} must be a positive integer`,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return input as number;
}

function nonNegInt(input: JsonValue, field: string): number {
	// SAFETY: assertion required at this I/O or test boundary.
	if (!Number.isSafeInteger(input) || (input as number) < 0) {
		throw new ResilienceValidationError(
			"expected-nonneg-int",
			`${field} must be a non-negative integer`,
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return input as number;
}
