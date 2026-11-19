
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
	seq: string;
}

interface CostView {
	freeUnitsPerMonth: number;
	listPriceUsdPerUnit: number;
	includedMultiplier: number;
	degraded: boolean;
}

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
