/**
 * CreditLedgerView projection: folds provider cost facts, budget envelopes,
 * usage snapshots, and hard-block evidence into the materialized view the
 * dispatcher consumes. Effective marginal cost is 0 while free headroom
 * remains and the declared list price after (ADR-0071); invalid or
 * misdeclared cost facts degrade to declared min-cost ranking (free tier
 * treated as absent) instead of throwing or chasing untrusted claims.
 */

import { create } from "@bufbuild/protobuf";

import {
	type BudgetEnvelope,
	CreditEntrySchema,
	type CreditLedgerView,
	CreditLedgerViewSchema,
	type HardBlockSignal,
	type RunnerProviderProfile,
	type UsageSnapshot,
} from "./_generated/runner_balancing_pb.js";

export interface LedgerInput {
	providers: readonly RunnerProviderProfile[];
	envelopes: ReadonlyMap<string, BudgetEnvelope>;
	snapshots: readonly UsageSnapshot[];
	hardBlocks?: readonly HardBlockSignal[];
	/** Pinned by the caller (event-store offset or timestamp token). */
	seq: string;
}

interface CostView {
	freeUnitsPerMonth: number;
	listPriceUsdPerUnit: number;
	includedMultiplier: number;
	degraded: boolean;
}

/**
 * Sanitize declared cost facts. Anything structurally unusable (negative
 * price, negative free tier, non-finite numbers) collapses to "no free
 * tier, non-negative list price" so a misdeclared provider can rank by
 * declared min cost but can never fabricate free headroom.
 */
function costView(provider: RunnerProviderProfile): CostView {
	const cost = provider.cost;
	const listPrice = cost?.listPriceUsdPerUnit ?? 0;
	const freeUnits = cost?.freeUnitsPerMonth ?? 0;
	const multiplier = cost?.includedMultiplier ?? 1;
	const valid =
		cost !== undefined &&
		Number.isFinite(listPrice) &&
		listPrice >= 0 &&
		Number.isFinite(freeUnits) &&
		freeUnits >= 0 &&
		Number.isFinite(multiplier) &&
		multiplier >= 0;

	if (!valid) {
		return {
			freeUnitsPerMonth: 0,
			listPriceUsdPerUnit: Math.max(0, Number.isFinite(listPrice) ? listPrice : 0),
			includedMultiplier: 1,
			degraded: true,
		};
	}
	return {
		freeUnitsPerMonth: freeUnits,
		listPriceUsdPerUnit: listPrice,
		includedMultiplier: multiplier === 0 ? 1 : multiplier,
		degraded: false,
	};
}

export function buildCreditLedgerView(input: LedgerInput): CreditLedgerView {
	const bySnapshot = new Map(
		input.snapshots.map((snapshot) => [snapshot.providerId, snapshot]),
	);
	const blockedProviders = new Set(
		(input.hardBlocks ?? [])
			.filter((signal) => signal.resource === "")
			.map((signal) => signal.providerId),
	);

	const entries = input.providers.map((provider) => {
		const cost = costView(provider);
		const snapshot = bySnapshot.get(provider.id);
		const envelope = input.envelopes.get(provider.id);
		const spendUsd = snapshot?.spendUsd ?? 0;
		const unitsUsed = snapshot?.unitsUsed ?? 0;
		const usageKnown = snapshot?.known ?? false;
		const freeHeadroomUnits = Math.max(
			0,
			cost.freeUnitsPerMonth - unitsUsed * cost.includedMultiplier,
		);
		const hardBlocked =
			blockedProviders.has(provider.id) ||
			(envelope !== undefined &&
				envelope.hardCapUsd > 0 &&
				usageKnown &&
				spendUsd >= envelope.hardCapUsd);

		return create(CreditEntrySchema, {
			providerId: provider.id,
			effectiveMarginalCostUsd:
				freeHeadroomUnits > 0 ? 0 : cost.listPriceUsdPerUnit,
			freeHeadroomUnits,
			spendUsd,
			envelopeUsd: envelope?.softCapUsd ?? 0,
			usageKnown,
			hardBlocked,
			listPriceUsdPerUnit: cost.listPriceUsdPerUnit,
		});
	});

	return create(CreditLedgerViewSchema, { seq: input.seq, entries });
}
