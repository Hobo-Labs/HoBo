/**
 * Dispatcher v2 ranks registered providers by minimum incremental **billed** cost
 * from `@hobo/pricing`. v1 (`decideDispatch`) stays untouched for credit ranking.
 */
import type { QuoteScenario } from "@hobo/pricing";
import { isQuoteVector, quoteScenario } from "@hobo/pricing";

import {
	type DispatchCategory,
	type DispatchProviderInput,
	createDispatcherRegistry,
	type DispatcherRegistry,
	DISPATCH_EVENTS,
	type DispatchFact,
	type DispatchDecidedData,
} from "./dispatcher.js";
import { isJsonString, type JsonValue } from "./json.js";

// public-contract: consumers pin the dispatcher v2 wire schema by this id.
export const DISPATCHER_V2_SCHEMA_VERSION = "hobo.dispatcher/v2";
// public-contract: v2 ranking objective identifier for dispatch.Decided facts.
export const DISPATCH_V2_OBJECTIVE = "min-incremental-billed" as const;

export type DispatchV2Objective = typeof DISPATCH_V2_OBJECTIVE;

export interface DispatchV2QuoteInput {
	readonly providerId: string;
	readonly scenario: QuoteScenario;
}

export interface DecideDispatchV2Request {
	readonly dispatchId: string;
	readonly category: DispatchCategory;
	readonly registry:
		| DispatcherRegistry
		| readonly DispatchProviderInput[];
	readonly quotes: readonly DispatchV2QuoteInput[];
	readonly reservationId?: string;
}

export interface DispatchV2RankingEntry {
	readonly providerId: string;
	readonly incrementalBilled: string;
	readonly currency: string;
	readonly quoteHash: string;
	readonly rationale: string;
}

export type DecideDispatchV2Result =
	| {
			readonly ok: true;
			readonly schema: typeof DISPATCHER_V2_SCHEMA_VERSION;
			readonly objective: DispatchV2Objective;
			readonly selectedProvider: string;
			readonly ranking: readonly DispatchV2RankingEntry[];
			readonly dispatchEvent: DispatchFact<DispatchDecidedData>;
	  }
	| {
			readonly ok: false;
			readonly schema: typeof DISPATCHER_V2_SCHEMA_VERSION;
			readonly objective: DispatchV2Objective;
			readonly reason: string;
			readonly rejectedCandidates: readonly string[];
	  };

function requireString(value: JsonValue | undefined, path: string): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${path} must be a non-empty string`);
	}
	return value;
}

interface IncrementalBilledQuote {
	readonly billed: string;
	readonly currency: string;
	readonly quoteHash: string;
}

function parseRegistry(
	registry: DecideDispatchV2Request["registry"],
): DispatcherRegistry {
	if (Array.isArray(registry)) {
		return createDispatcherRegistry([...registry]);
	}
	// SAFETY: non-array registry inputs are always createDispatcherRegistry output.
	return registry as DispatcherRegistry;
}

function incrementalBilled(scenario: QuoteScenario): IncrementalBilledQuote {
	const result = quoteScenario(scenario);
	if (!isQuoteVector(result)) {
		throw new Error(`${result.code}: ${result.message}`);
	}
	const billed = result.incremental?.billed;
	if (billed === undefined) {
		throw new Error("quote missing incremental.billed");
	}
	return {
		billed: billed.decimal,
		currency: billed.currency,
		quoteHash: result.quoteHash,
	};
}

function compareDecimalStrings(left: string, right: string): number {
	const a = left.split(".");
	const b = right.split(".");
	const scale = Math.max(a[1]?.length ?? 0, b[1]?.length ?? 0);
	const leftInt = BigInt(`${a[0] ?? "0"}${(a[1] ?? "").padEnd(scale, "0")}`);
	const rightInt = BigInt(`${b[0] ?? "0"}${(b[1] ?? "").padEnd(scale, "0")}`);
	if (leftInt < rightInt) return -1;
	if (leftInt > rightInt) return 1;
	return 0;
}

export function decideDispatchV2(
	request: DecideDispatchV2Request,
): DecideDispatchV2Result {
	const dispatchId = requireString(request.dispatchId, "request.dispatchId");
	const category = request.category;
	const registry = parseRegistry(request.registry);
	const candidates = registry.byCategory.get(category) ?? [];
	const registered = new Set(
		candidates.filter((c) => c.registered).map((c) => c.providerId),
	);

	if (registered.size === 0) {
		return {
			ok: false,
			schema: DISPATCHER_V2_SCHEMA_VERSION,
			objective: DISPATCH_V2_OBJECTIVE,
			reason: `no registered ${category} candidates`,
			rejectedCandidates: [],
		};
	}

	const rejected: string[] = [];
	const ranked: DispatchV2RankingEntry[] = [];

	for (const quote of request.quotes ?? []) {
		if (!registered.has(quote.providerId)) continue;
		try {
			const { billed, currency, quoteHash } = incrementalBilled(quote.scenario);
			ranked.push({
				providerId: quote.providerId,
				incrementalBilled: billed,
				currency,
				quoteHash,
				rationale: `min-incremental-billed=${billed} ${currency}`,
			});
		} catch {
			rejected.push(quote.providerId);
		}
	}

	for (const providerId of registered) {
		if (!ranked.some((entry) => entry.providerId === providerId)) {
			rejected.push(providerId);
		}
	}

	if (ranked.length === 0) {
		return {
			ok: false,
			schema: DISPATCHER_V2_SCHEMA_VERSION,
			objective: DISPATCH_V2_OBJECTIVE,
			reason: "pricing quote unavailable for every candidate",
			rejectedCandidates: rejected,
		};
	}

	ranked.sort((left, right) => {
		const byCost = compareDecimalStrings(
			left.incrementalBilled,
			right.incrementalBilled,
		);
		if (byCost !== 0) return byCost;
		return left.providerId.localeCompare(right.providerId);
	});

	const winner = ranked[0];
	if (!winner) {
		return {
			ok: false,
			schema: DISPATCHER_V2_SCHEMA_VERSION,
			objective: DISPATCH_V2_OBJECTIVE,
			reason: "pricing ranking produced no winner",
			rejectedCandidates: rejected,
		};
	}

	const reservationId =
		request.reservationId ?? `reservation-intent-${dispatchId}`;

	const dispatchEvent: DispatchFact<DispatchDecidedData> = {
		type: DISPATCH_EVENTS.DispatchDecided,
		data: {
			dispatchId,
			category,
			selectedProvider: winner.providerId,
			// SAFETY: v2 objective is a distinct ranking mode not present on v1 DispatchObjective.
			objective: DISPATCH_V2_OBJECTIVE as never,
			ledgerInput: {
				view: "CreditLedgerView",
				seq: 0,
				reservationId,
				balanceHash: `sha256:${"0".repeat(64)}`,
			},
			candidates: ranked.map((entry) => ({
				provider: entry.providerId,
				effectiveMarginalCost: Number.parseFloat(entry.incrementalBilled),
				rationale: entry.rationale,
			})),
		},
	};

	return {
		ok: true,
		schema: DISPATCHER_V2_SCHEMA_VERSION,
		objective: DISPATCH_V2_OBJECTIVE,
		selectedProvider: winner.providerId,
		ranking: ranked,
		dispatchEvent,
	};
}
