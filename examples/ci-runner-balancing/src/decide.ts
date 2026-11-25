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
	current: Readonly<Record<string, string | undefined>>;
	ledger: CreditLedgerView;
	pins: ReadonlySet<string>;
	resourceBlocks?: readonly HardBlockSignal[] | undefined;
	flipUpPct?: number | undefined;
	flipBackPct?: number | undefined;
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
