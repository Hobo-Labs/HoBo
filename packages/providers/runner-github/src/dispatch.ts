import { createHash } from "node:crypto";

import type { JsonValue } from "./json.js";
import { parseExecutionHostManifest } from "./manifest.js";
import {
	CATEGORY_SKUS,
	type ExecutionHostCategory,
	type ExecutionHostManifest,
} from "./types.js";

export const DISPATCH_DECIDED = "dispatch.Decided";

export const OBJECTIVES = [
	"cost",
	"latency",
	"single-provider",
	"carbon",
	"maximize-credits",
] as const;

export type DispatchObjective = (typeof OBJECTIVES)[number];

export interface ExecutionHostProviderLike {
	readonly id: string;
	readonly category: ExecutionHostCategory;
	capabilityManifest(): ExecutionHostManifest;
}

export interface ExecutionHostRecord {
	readonly provider: ExecutionHostProviderLike;
	readonly manifest: ExecutionHostManifest;
	readonly id: string;
	readonly category: ExecutionHostCategory;
}

export interface ExecutionHostRegistry {
	readonly providers: ExecutionHostProviderLike[];
	readonly byCategory: Map<ExecutionHostCategory, ExecutionHostRecord[]>;
	readonly byId: Map<string, ExecutionHostRecord>;
}

export interface CreditLedgerView {
	readonly seq: number;
	readonly balanceHash: string;
	readonly balances: Record<
		string,
		Record<string, { freeHeadroom?: number; marginalUnitCost?: number }>
	>;
}

export interface DispatchCandidate {
	readonly providerId: string;
	readonly category: ExecutionHostCategory;
	readonly effectiveMarginalCost: number;
	readonly totalCost: number;
	readonly costTrust: string;
}

export interface DispatchDecision {
	readonly selectedProvider: string;
	readonly category: ExecutionHostCategory;
	readonly routingMode: "ranked" | "pinned";
	readonly optedOutOfRouting: boolean;
	readonly candidates: DispatchCandidate[];
	readonly dispatchDecided: {
		readonly type: typeof DISPATCH_DECIDED;
		readonly data: {
			readonly dispatchId: string;
			readonly category: ExecutionHostCategory;
			readonly selectedProvider: string;
			readonly objective: DispatchObjective;
			readonly ledgerInput: {
				readonly view: "CreditLedgerView";
				readonly seq: number;
				readonly reservationId: string;
				readonly balanceHash: string;
			};
			readonly candidates: Array<{
				readonly provider: string;
				readonly effectiveMarginalCost: number;
			}>;
		};
	};
}

export interface DispatchRequest {
	readonly category: ExecutionHostCategory;
	readonly dispatchId: string;
	readonly objective?: DispatchObjective;
	readonly units?: number;
	readonly ledgerView?: CreditLedgerView;
	readonly withProvider?: string;
}

export function createExecutionHostRegistry(
	providers: ExecutionHostProviderLike[] = [],
): ExecutionHostRegistry {
	const byCategory = new Map<ExecutionHostCategory, ExecutionHostRecord[]>();
	const byId = new Map<string, ExecutionHostRecord>();

	for (const provider of providers) {
		const manifest = provider.capabilityManifest();
		const parsed = parseExecutionHostManifest(manifest, {
			category: provider.category,
		});
		if (!parsed.ok) {
			throw new Error(
				`provider ${provider.id} has invalid manifest: ${parsed.errors.join("; ")}`,
			);
		}
		const record: ExecutionHostRecord = {
			provider,
			manifest,
			id: provider.id,
			category: provider.category,
		};
		byId.set(`${provider.category}:${provider.id}`, record);
		const bucket = byCategory.get(provider.category) ?? [];
		bucket.push(record);
		byCategory.set(provider.category, bucket);
	}

	return { providers: [...providers], byCategory, byId };
}

export function emptyLedgerView(): CreditLedgerView {
	return { seq: 0, balanceHash: digestRef({ empty: true }), balances: {} };
}

function rankCandidate(
	record: ExecutionHostRecord,
	ledgerView: CreditLedgerView,
	units: number,
): DispatchCandidate {
	const sku = CATEGORY_SKUS[record.category];
	const quote = ledgerView.balances?.[record.id]?.[sku] ?? {};
	const freeHeadroom = quote.freeHeadroom ?? 0;
	const listUnitCost =
		quote.marginalUnitCost ??
		Number(record.manifest.cost.facts[0]?.marginalPrice ?? "0");
	const paidUnits = Math.max(0, units - freeHeadroom);
	const totalCost = Number((paidUnits * listUnitCost).toFixed(10));
	return {
		providerId: record.id,
		category: record.category,
		effectiveMarginalCost: freeHeadroom >= units ? 0 : listUnitCost,
		totalCost,
		costTrust: "declared-unverified",
	};
}

export function selectExecutionHost(
	request: DispatchRequest,
	registry: ExecutionHostRegistry,
): DispatchDecision {
	const category = request.category;
	const objective = request.objective ?? "maximize-credits";
	if (!OBJECTIVES.includes(objective)) {
		throw new Error(`unsupported objective ${objective}`);
	}
	if (request.dispatchId.length === 0) {
		throw new Error("dispatchId must be a non-empty string");
	}
	const units = request.units ?? 1;
	const ledgerView = request.ledgerView ?? emptyLedgerView();

	if (request.withProvider) {
		const pinned = registry.byId.get(`${category}:${request.withProvider}`);
		if (!pinned) {
			throw new Error(
				`pinned provider ${request.withProvider} is not registered for ${category}`,
			);
		}
		return createDecision({
			dispatchId: request.dispatchId,
			category,
			objective,
			ledgerView,
			selected: pinned,
			candidates: [rankCandidate(pinned, ledgerView, units)],
			routingMode: "pinned",
			optedOutOfRouting: true,
		});
	}

	const candidates = (registry.byCategory.get(category) ?? [])
		.map((record) => rankCandidate(record, ledgerView, units))
		.sort((left, right) => {
			if (left.effectiveMarginalCost !== right.effectiveMarginalCost) {
				return left.effectiveMarginalCost - right.effectiveMarginalCost;
			}
			return left.providerId.localeCompare(right.providerId);
		});

	if (candidates.length === 0) {
		throw new Error(`no registered providers for ${category}`);
	}

	const winner = candidates[0];
	if (winner === undefined) {
		throw new Error(`no registered providers for ${category}`);
	}
	const selected = registry.byId.get(`${category}:${winner.providerId}`);
	if (selected === undefined) {
		throw new Error(`no registered providers for ${category}`);
	}
	return createDecision({
		dispatchId: request.dispatchId,
		category,
		objective,
		ledgerView,
		selected,
		candidates,
		routingMode: "ranked",
		optedOutOfRouting: false,
	});
}

function createDecision(input: {
	dispatchId: string;
	category: ExecutionHostCategory;
	objective: DispatchObjective;
	ledgerView: CreditLedgerView;
	selected: ExecutionHostRecord;
	candidates: DispatchCandidate[];
	routingMode: "ranked" | "pinned";
	optedOutOfRouting: boolean;
}): DispatchDecision {
	return {
		selectedProvider: input.selected.id,
		category: input.category,
		routingMode: input.routingMode,
		optedOutOfRouting: input.optedOutOfRouting,
		candidates: input.candidates,
		dispatchDecided: {
			type: DISPATCH_DECIDED,
			data: {
				dispatchId: input.dispatchId,
				category: input.category,
				selectedProvider: input.selected.id,
				objective: input.objective,
				ledgerInput: {
					view: "CreditLedgerView",
					seq: input.ledgerView.seq,
					reservationId: `reserve-${input.dispatchId}`,
					balanceHash: input.ledgerView.balanceHash,
				},
				candidates: input.candidates.map((candidate) => ({
					provider: candidate.providerId,
					effectiveMarginalCost: candidate.effectiveMarginalCost,
				})),
			},
		},
	};
}

function digestRef(value: JsonValue): string {
	return `sha256:${createHash("sha256")
		.update(JSON.stringify(value))
		.digest("hex")}`;
}
