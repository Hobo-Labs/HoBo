/**
 * Pure credit-aware dispatcher (ADR-0071 `maximize-credits`). No I/O, no
 * clock, no provider names: callers hand in a pinned CreditLedgerView plus
 * the current routed-variable values, and get back `dispatch.Decided`
 * records. Imports are restricted to the generated protobuf module and its
 * runtime constructor (enforced by test/decide.test.ts) so replaying the
 * same input always yields the same decisions.
 *
 * Ranking, per track: candidates are ordered by effective marginal cost
 * (0 while free headroom remains), then declared list price, then stable
 * rung order — free credits are exhausted before realtime billing starts.
 * Hysteresis holds the incumbent: a provider is left at >= flipUpPct of its
 * soft cap and only returned to below flipBackPct (anti-flap). When no rung
 * is eligible the track fails closed instead of guessing.
 */

import { create } from "@bufbuild/protobuf";

import {
	type CreditEntry,
	type CreditLedgerView,
	DecisionKind,
	type DispatchDecision,
	DispatchDecisionSchema,
	type HardBlockSignal,
	type RunnerTrack,
	type TrackRung,
} from "./_generated/runner_balancing_pb.js";

export interface DecideInput {
	tracks: readonly RunnerTrack[];
	/** Current variable values (GitHub is the source of truth, never mirrored). */
	current: Readonly<Record<string, string | undefined>>;
	/** Pinned ledger view; every decision records ledger.seq for replay. */
	ledger: CreditLedgerView;
	/** Variables the operator froze. */
	pins: ReadonlySet<string>;
	/** Track-scoped failure evidence (provider-wide blocks live on the ledger). */
	resourceBlocks?: readonly HardBlockSignal[] | undefined;
	/** Leave a provider when known spend >= soft cap * flipUpPct. */
	flipUpPct?: number | undefined;
	/** Return to a cheaper rung only when its spend < soft cap * flipBackPct. */
	flipBackPct?: number | undefined;
	/** Allow leaving rungs marked sticky_reason (non-fungible capability). */
	allowNonFungibleFallback?: boolean | undefined;
}

const FALLBACK_ENTRY = {
	effectiveMarginalCostUsd: Number.POSITIVE_INFINITY,
	listPriceUsdPerUnit: Number.POSITIVE_INFINITY,
	spendUsd: 0,
	envelopeUsd: 0,
	usageKnown: false,
	hardBlocked: false,
	freeHeadroomUnits: 0,
} as const;

type LedgerRow = Pick<
	CreditEntry,
	| "effectiveMarginalCostUsd"
	| "listPriceUsdPerUnit"
	| "spendUsd"
	| "envelopeUsd"
	| "usageKnown"
	| "hardBlocked"
	| "freeHeadroomUnits"
>;

function ledgerRow(ledger: CreditLedgerView, providerId: string): LedgerRow {
	return (
		ledger.entries.find((entry) => entry.providerId === providerId) ??
		FALLBACK_ENTRY
	);
}

function guardsMet(
	rung: TrackRung,
	current: Readonly<Record<string, string | undefined>>,
): boolean {
	return rung.requires.every((guard) => {
		const value = current[guard.variable] ?? "";
		if (guard.values.length > 0) return guard.values.includes(value);
		if (guard.exists) return value.length > 0;
		return true;
	});
}

function underThreshold(row: LedgerRow, pct: number): boolean {
	// Unknown usage is treated as available; the decision carries
	// usageKnown=false so an unverified flip is never presented as
	// spend-aware routing.
	if (!row.usageKnown) return true;
	return row.spendUsd < row.envelopeUsd * pct;
}

interface RankedRung {
	rung: TrackRung;
	row: LedgerRow;
	index: number;
	blocked: boolean;
}

function rankRungs(
	track: RunnerTrack,
	input: DecideInput,
): readonly RankedRung[] {
	const blocks = input.resourceBlocks ?? [];
	return track.rungs
		.map((rung, index) => {
			const row = ledgerRow(input.ledger, rung.providerId);
			const blocked =
				row.hardBlocked ||
				blocks.some(
					(signal) =>
						signal.providerId === rung.providerId &&
						(signal.resource === "" || signal.resource === track.resource),
				);
			return { rung, row, index, blocked };
		})
		.sort(
			// Last-resort rungs (the requesting machine) rank behind every
			// normal rung regardless of declared cost: first-eligible
			// selection then reaches them only when nothing else is usable,
			// and leaves them as soon as a normal rung recovers.
			(left, right) =>
				Number(left.rung.lastResort) - Number(right.rung.lastResort) ||
				left.row.effectiveMarginalCostUsd - right.row.effectiveMarginalCostUsd ||
				left.row.listPriceUsdPerUnit - right.row.listPriceUsdPerUnit ||
				left.index - right.index,
		);
}

function baseDecision(
	track: RunnerTrack,
	input: DecideInput,
): Pick<DispatchDecision, "resource" | "variable" | "ledgerSeq"> {
	return {
		resource: track.resource,
		variable: track.variable,
		ledgerSeq: input.ledger.seq,
	};
}

export function decide(input: DecideInput): DispatchDecision[] {
	const flipUpPct = input.flipUpPct ?? 0.9;
	const flipBackPct = input.flipBackPct ?? 0.8;
	const decisions: DispatchDecision[] = [];

	for (const track of input.tracks) {
		if (input.pins.has(track.variable)) {
			decisions.push(
				create(DispatchDecisionSchema, {
					...baseDecision(track, input),
					kind: DecisionKind.PIN_SKIP,
					reason: "variable pinned by operator",
				}),
			);
			continue;
		}

		const currentValue = input.current[track.variable];
		const ranked = rankRungs(track, input);
		const currentRank = ranked.findIndex(
			(candidate) => candidate.rung.value === currentValue,
		);
		const currentRung = currentRank === -1 ? undefined : ranked[currentRank];

		const eligibleRank = ranked.findIndex(
			(candidate) =>
				!candidate.blocked &&
				guardsMet(candidate.rung, input.current) &&
				underThreshold(candidate.row, flipUpPct),
		);
		const target = eligibleRank === -1 ? undefined : ranked[eligibleRank];

		if (target === undefined) {
			decisions.push(
				create(DispatchDecisionSchema, {
					...baseDecision(track, input),
					kind: DecisionKind.FAIL_CLOSED,
					fromValue: currentValue ?? "(unset)",
					toValue: currentValue ?? "",
					reason:
						"no rung is eligible: every candidate (including any last-resort rung) is hard-blocked, guarded off, or at/over its budget envelope",
				}),
			);
			continue;
		}

		if (currentRung !== undefined && target.rung.value === currentValue) {
			decisions.push(
				create(DispatchDecisionSchema, {
					...baseDecision(track, input),
					kind: DecisionKind.NO_CHANGE,
					fromValue: currentValue ?? "",
					toValue: currentValue ?? "",
					providerId: currentRung.rung.providerId,
					usageKnown: currentRung.row.usageKnown,
					spendUsd: currentRung.row.spendUsd,
					envelopeUsd: currentRung.row.envelopeUsd,
				}),
			);
			continue;
		}

		const movingBack = currentRung !== undefined && eligibleRank < currentRank;

		if (movingBack && !underThreshold(target.row, flipBackPct)) {
			// Cheaper rung is still inside the flipBack..flipUp band: hold to
			// avoid flapping between providers on every pass.
			decisions.push(
				create(DispatchDecisionSchema, {
					...baseDecision(track, input),
					kind: DecisionKind.NO_CHANGE,
					fromValue: currentValue ?? "",
					toValue: currentValue ?? "",
					providerId: currentRung.rung.providerId,
					usageKnown: currentRung.row.usageKnown,
					spendUsd: currentRung.row.spendUsd,
					envelopeUsd: currentRung.row.envelopeUsd,
					reason: `hysteresis hold: ${target.rung.providerId} is inside the flip-back band`,
				}),
			);
			continue;
		}

		if (
			currentRung !== undefined &&
			currentRung.rung.stickyReason !== "" &&
			input.allowNonFungibleFallback !== true
		) {
			decisions.push(
				create(DispatchDecisionSchema, {
					...baseDecision(track, input),
					kind: DecisionKind.NON_FUNGIBLE_HOLD,
					fromValue: currentValue ?? "",
					toValue: currentValue ?? "",
					providerId: currentRung.rung.providerId,
					usageKnown: currentRung.row.usageKnown,
					spendUsd: currentRung.row.spendUsd,
					envelopeUsd: currentRung.row.envelopeUsd,
					reason: `non-fungible rung held (${currentRung.rung.stickyReason}); wanted ${target.rung.value}`,
				}),
			);
			continue;
		}

		decisions.push(
			create(DispatchDecisionSchema, {
				...baseDecision(track, input),
				kind: DecisionKind.FLIP,
				fromValue: currentValue ?? "(unset)",
				toValue: target.rung.value,
				providerId: target.rung.providerId,
				usageKnown: target.row.usageKnown,
				spendUsd: target.row.spendUsd,
				envelopeUsd: target.row.envelopeUsd,
				direction: currentRung === undefined || movingBack ? "back" : "up",
				reason: target.rung.lastResort
					? "last resort: every normal rung is blocked or over budget; failing over to the requesting machine"
					: target.row.freeHeadroomUnits > 0
						? "free credit headroom available"
						: "cheapest eligible list price under budget",
			}),
		);
	}

	return decisions;
}
