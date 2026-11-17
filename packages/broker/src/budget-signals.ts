// Budget signal plane: turns the static spend-cap check (planes.ts /
// metering.ts) into a stream. The same `meter.UsageRecorded` facts the metered
// billing plane folds are folded here into per-tenant budget state, and
// threshold transitions emit `budget.ThresholdCrossed` / `budget.Recovered`
// facts a routing control loop can subscribe to (the "decide" trigger the
// FinOps control-plane design defers — only the threshold evaluator is lifted,
// not the Pareto pipeline).
//
// On replay, the fold reconstructs each signal from financial facts and
// suppresses only an identical recorded signal. Conflicts with a reconstructed
// signal or a journal idempotency key require reconciliation. The caller must
// provide a complete target stream including its metadata; `budgetSignalEventInputs`
// carries the signalKey as `meta.idempotencyKey` for journal deduplication.
import { createHash } from "node:crypto";
import {
	type BudgetScopeIdentity,
	budgetScopeIdentityKey,
	budgetThresholdSignalKey,
} from "@hobo/core";
import {
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import { METER_USAGE_RECORDED_EVENT } from "./metering.js";

export const BUDGET_EVENTS = Object.freeze({
	ThresholdCrossed: "budget.ThresholdCrossed",
	Recovered: "budget.Recovered",
	// Operator-appended fact that restores headroom (grant, top-up, correction).
	CreditApplied: "budget.CreditApplied",
	StateReset: "budget.StateReset",
} as const);

export interface BudgetSignalPolicy {
	/** Hard budget in USD; zero is already crossed at initialization. */
	budgetUsd: number;
	/** Threshold fractions of budgetUsd in (0, 1]; default [1]. */
	thresholds?: readonly number[];
	/** Scope: only facts with this data.tenantId are folded (absent = all). */
	tenantId?: string;
	/** V2 scope. Usage/credit facts must carry matching budgetId and periodId.
	 * Omission is the legacy lifetime/tenant stream, without rollover semantics. */
	identity?: BudgetScopeIdentity;
}

export interface BudgetSignalState {
	tenantId: string | null;
	budgetUsd: number;
	spentUsd: number;
	creditUsd: number;
	netSpentUsd: number;
	sampleCount: number;
	/** thresholdFraction -> currently crossed */
	crossed: Record<string, boolean>;
}

export interface BudgetSignalData {
	tenantId: string | null;
	thresholdFraction: number;
	thresholdUsd: number;
	budgetUsd: number;
	netSpentUsd: number;
	/** 1-based count of crossings/recoveries for this threshold — identity. */
	cycle: number;
	signalKey: string;
	identity?: BudgetScopeIdentity;
	policyDigest?: string | undefined;
	crossed?: boolean;
}

export interface BudgetSignal {
	type:
		| typeof BUDGET_EVENTS.ThresholdCrossed
		| typeof BUDGET_EVENTS.Recovered
		| typeof BUDGET_EVENTS.StateReset;
	data: BudgetSignalData;
}

interface FactLike {
	type: string;
	data?: unknown;
	meta?: unknown;
}

export interface BudgetSignalFold {
	state: BudgetSignalState;
	signals: BudgetSignal[];
}

function sameIdentity(
	value: JsonValue | undefined,
	identity: BudgetScopeIdentity,
): boolean {
	return (
		isJsonObject(value) &&
		value.tenantId === identity.tenantId &&
		value.budgetId === identity.budgetId &&
		value.periodId === identity.periodId &&
		value.policyRevision === identity.policyRevision
	);
}

function matchesSignal(data: JsonObject, expected: BudgetSignalData): boolean {
	return (
		data.tenantId === expected.tenantId &&
		data.thresholdFraction === expected.thresholdFraction &&
		data.thresholdUsd === expected.thresholdUsd &&
		data.budgetUsd === expected.budgetUsd &&
		data.netSpentUsd === expected.netSpentUsd &&
		data.cycle === expected.cycle &&
		data.signalKey === expected.signalKey &&
		data.policyDigest === expected.policyDigest &&
		data.crossed === expected.crossed &&
		(expected.identity
			? sameIdentity(data.identity, expected.identity)
			: data.identity === undefined)
	);
}

// Deterministic fold: same stream + same policy -> same state and the same
// signal facts (stable signalKey identity), so projections rebuilt from zero
// converge instead of re-firing.
export function foldBudgetSignals(
	events: Iterable<FactLike>,
	policy: BudgetSignalPolicy,
): BudgetSignalFold {
	const budgetUsd = policy.budgetUsd;
	if (!Number.isFinite(budgetUsd) || budgetUsd < 0) {
		throw new TypeError("policy.budgetUsd must be a nonnegative number");
	}
	const thresholds = [...(policy.thresholds ?? [1])].sort((a, b) => a - b);
	if (
		thresholds.length === 0 ||
		new Set(thresholds).size !== thresholds.length ||
		thresholds.some((t) => !Number.isFinite(t) || t <= 0 || t > 1)
	) {
		throw new TypeError("policy.thresholds must be fractions in (0, 1]");
	}
	const identity = policy.identity
		? {
				tenantId: policy.identity.tenantId,
				budgetId: policy.identity.budgetId,
				periodId: policy.identity.periodId,
				policyRevision: policy.identity.policyRevision,
			}
		: undefined;
	if (identity) budgetScopeIdentityKey(identity);
	if (
		identity &&
		policy.tenantId !== undefined &&
		identity.tenantId !== policy.tenantId
	)
		throw new TypeError("budget tenant identity mismatch");
	const tenantId = identity?.tenantId ?? policy.tenantId ?? null;
	const policyDigest = identity
		? createHash("sha256")
				.update(JSON.stringify({ budgetUsd, thresholds }))
				.digest("hex")
		: undefined;
	const signalKey = (
		threshold: number,
		transition: "crossed" | "recovered" | "reset",
		cycle: number,
	) =>
		identity
			? budgetThresholdSignalKey(identity, threshold, transition, cycle)
			: `budget:${tenantId ?? "*"}:${threshold}:${transition}:${cycle}`;

	const state: BudgetSignalState = {
		tenantId,
		budgetUsd,
		spentUsd: 0,
		creditUsd: 0,
		netSpentUsd: 0,
		sampleCount: 0,
		crossed: Object.fromEntries(
			thresholds.map((t) => [String(t), budgetUsd === 0]),
		),
	};
	const cycles: Record<string, number> = Object.fromEntries(
		thresholds.map((t) => [String(t), 0]),
	);
	const signals: BudgetSignal[] = [];

	// Pre-scan for already-recorded signal identities BEFORE folding: appended
	// signals sit after the usage facts in global order, and dedupe must not
	// depend on where in the stream they landed.
	const buffered = Array.isArray(events) ? events : [...events];
	const recorded = new Map<
		string,
		Array<{ type: string; data: unknown; metadataKey: unknown }>
	>();
	for (const event of buffered) {
		const isSignal =
			event.type === BUDGET_EVENTS.ThresholdCrossed ||
			event.type === BUDGET_EVENTS.Recovered ||
			event.type === BUDGET_EVENTS.StateReset;
		const data = event.data;
		const metadataKey = isJsonObject(event.meta)
			? event.meta.idempotencyKey
			: undefined;
		if (isSignal && isJsonObject(data)) {
			const belongsToPolicy = identity
				? sameIdentity(data.identity, identity)
				: data.tenantId === tenantId && data.identity === undefined;
			if (belongsToPolicy) {
				if (data.tenantId !== tenantId)
					throw new TypeError(
						"budget signal scope conflicts with its identity; reconcile the journal",
					);
				if (identity && data.policyDigest !== policyDigest)
					throw new TypeError(
						"budget cap or thresholds changed without a policy revision",
					);
				if (!isJsonString(data.signalKey) || !data.signalKey)
					throw new TypeError(
						"budget signal identity is missing; reconcile the journal",
					);
			}
		}
		// The journal deduplicates idempotency keys within a stream, regardless
		// of event type or scope. A conflicting row must not hide the signal.
		const keys = new Set<string>();
		if (
			isSignal &&
			isJsonObject(data) &&
			isJsonString(data.signalKey) &&
			data.signalKey
		)
			keys.add(data.signalKey);
		if (isJsonString(metadataKey) && metadataKey) keys.add(metadataKey);
		for (const key of keys) {
			const entries = recorded.get(key) ?? [];
			entries.push({ type: event.type, data, metadataKey });
			recorded.set(key, entries);
		}
	}
	const emitted = new Set<string>();
	function emitOrCheck(signal: BudgetSignal): void {
		const key = signal.data.signalKey;
		const entries = recorded.get(key) ?? [];
		if (
			entries.some(
				(entry) =>
					entry.type !== signal.type ||
					!isJsonObject(entry.data) ||
					!matchesSignal(entry.data, signal.data) ||
					(entry.metadataKey !== undefined && entry.metadataKey !== key),
			)
		)
			throw new TypeError(
				"budget signal conflicts with reconstructed transition; reconcile the journal",
			);
		if (entries.length || emitted.has(key)) return;
		emitted.add(key);
		signals.push(signal);
	}
	// Reset is an explicit V2 fact, so subscribers can retire the old period or
	// revision before consuming its independently numbered threshold transitions.
	if (identity)
		for (const threshold of thresholds) {
			const key = signalKey(threshold, "reset", 0);
			emitOrCheck({
				type: BUDGET_EVENTS.StateReset,
				data: {
					tenantId,
					identity,
					policyDigest,
					thresholdFraction: threshold,
					thresholdUsd: round(threshold * budgetUsd),
					budgetUsd,
					netSpentUsd: 0,
					cycle: 0,
					crossed: budgetUsd === 0,
					signalKey: key,
				},
			});
		}

	for (const event of buffered) {
		if (
			event.type === BUDGET_EVENTS.ThresholdCrossed ||
			event.type === BUDGET_EVENTS.Recovered ||
			event.type === BUDGET_EVENTS.StateReset
		) {
			continue;
		}
		if (
			event.type !== METER_USAGE_RECORDED_EVENT &&
			event.type !== BUDGET_EVENTS.CreditApplied
		)
			continue;
		const data = event.data;
		if (!isJsonObject(data))
			throw new TypeError("financial fact scope and amount are required");
		if (tenantId !== null) {
			if (!isJsonString(data.tenantId) || !data.tenantId)
				throw new TypeError("financial fact tenant scope is required");
			if (data.tenantId !== tenantId) continue;
		}
		if (identity) {
			if (
				!isJsonString(data.budgetId) ||
				!data.budgetId ||
				!isJsonString(data.periodId) ||
				!data.periodId
			)
				throw new TypeError(
					"financial fact budget and period scope are required",
				);
			if (
				data.budgetId !== identity.budgetId ||
				data.periodId !== identity.periodId
			)
				continue;
		}

		if (event.type === METER_USAGE_RECORDED_EVENT) {
			const cost = data.costUsd;
			if (!isJsonNumber(cost) || !Number.isFinite(cost) || cost < 0) {
				throw new TypeError("usage charge must be finite and nonnegative");
			}
			const next = state.spentUsd + cost;
			if (!Number.isFinite(next)) throw new TypeError("usage spend overflow");
			state.spentUsd = next;
			state.sampleCount += 1;
		} else if (event.type === BUDGET_EVENTS.CreditApplied) {
			const amount = data.amountUsd;
			if (!isJsonNumber(amount) || !Number.isFinite(amount) || amount < 0) {
				throw new TypeError("credit amount must be finite and nonnegative");
			}
			const next = state.creditUsd + amount;
			if (!Number.isFinite(next)) throw new TypeError("credit total overflow");
			state.creditUsd = next;
		}

		state.netSpentUsd = round(state.spentUsd - state.creditUsd);
		for (const threshold of thresholds) {
			const key = String(threshold);
			const crossedNow = state.netSpentUsd >= round(threshold * budgetUsd);
			if (crossedNow === state.crossed[key]) continue;
			state.crossed[key] = crossedNow;
			const cycle = (cycles[key] ?? 0) + 1;
			cycles[key] = cycle;
			const signal: BudgetSignal = {
				type: crossedNow
					? BUDGET_EVENTS.ThresholdCrossed
					: BUDGET_EVENTS.Recovered,
				data: {
					tenantId,
					thresholdFraction: threshold,
					thresholdUsd: round(threshold * budgetUsd),
					budgetUsd,
					netSpentUsd: state.netSpentUsd,
					cycle,
					signalKey: signalKey(
						threshold,
						crossedNow ? "crossed" : "recovered",
						cycle,
					),
				},
			};
			if (identity) {
				signal.data.identity = identity;
				signal.data.policyDigest = policyDigest;
				signal.data.crossed = crossedNow;
			}
			emitOrCheck(signal);
		}
	}

	return { state, signals };
}

// EventInput-shaped (core eventstore) rows for appending fold output to a
// journal; the signalKey rides as meta.idempotencyKey so the journal dedupes
// a re-append of the same signal.
export function budgetSignalEventInputs(signals: readonly BudgetSignal[]): {
	type: string;
	data: BudgetSignalData;
	meta: { idempotencyKey: string };
}[] {
	return signals.map((signal) => ({
		type: signal.type,
		data: signal.data,
		meta: { idempotencyKey: signal.data.signalKey },
	}));
}

function round(value: number): number {
	return Number(value.toFixed(9));
}
