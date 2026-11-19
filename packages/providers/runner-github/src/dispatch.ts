import { createHash } from "node:crypto";
import { type BuildCostObservationRecord, sortKeys } from "@hobo/core";

import { isJsonString, type JsonValue } from "./json.js";
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
	readonly buildId?: string;
	readonly balances: Record<
		string,
		Record<
			string,
			{
				freeHeadroom?: number;
				marginalUnitCost?: number;
				meteredUnitFactor?: number;
			}
		>
	>;
}

export type BuildCostObservation = Readonly<
	Omit<BuildCostObservationRecord, "$typeName">
>;

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
	readonly buildId?: string;
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

function declaredUnitCost(record: ExecutionHostRecord, sku: string): number {
	const price = record.manifest.cost.facts.find(
		(fact) => fact.sku === sku,
	)?.marginalPrice;
	if (!isJsonString(price) || !/^[0-9]+(?:\.[0-9]+)?$/.test(price))
		throw new TypeError(`invalid declared cost for ${record.id}`);
	const value = Number(price);
	if (!Number.isFinite(value))
		throw new TypeError(`invalid declared cost for ${record.id}`);
	return value;
}

export function projectBuildCosts(
	ledgerView: CreditLedgerView,
	registry: ExecutionHostRegistry,
	buildId: string,
	observations: readonly BuildCostObservation[],
): CreditLedgerView {
	if (!buildId.trim()) throw new TypeError("buildId must be non-empty");
	if (ledgerView.buildId !== undefined && ledgerView.buildId !== buildId)
		throw new TypeError("ledger view belongs to another build");
	if (!Number.isSafeInteger(ledgerView.seq) || ledgerView.seq < 0)
		throw new TypeError("ledger sequence must be a non-negative safe integer");
	const balances = new Map(
		Object.entries(ledgerView.balances).map(([provider, accounts]) => [
			provider,
			new Map(Object.entries(accounts)),
		]),
	);
	let seq = ledgerView.seq;
	for (const observation of observations) {
		if (
			observation.type !== "build.CacheHitObserved" ||
			!Number.isSafeInteger(observation.seq) ||
			observation.seq <= seq ||
			!observation.providerId.trim() ||
			!observation.buildId.trim() ||
			!Number.isFinite(observation.estimatedUnits) ||
			observation.estimatedUnits <= 0 ||
			!Number.isFinite(observation.meteredUnits) ||
			observation.meteredUnits < 0
		)
			throw new TypeError("invalid or out-of-order build cost observation");
		seq = observation.seq;
		if (observation.buildId !== buildId) continue;
		const provider = registry.byId.get(
			`build-machine:${observation.providerId}`,
		);
		if (!provider)
			throw new TypeError(
				`unregistered build provider ${observation.providerId}`,
			);
		const sku = CATEGORY_SKUS["build-machine"];
		const listPrice = declaredUnitCost(provider, sku);
		const factor = observation.meteredUnits / observation.estimatedUnits;
		const marginalUnitCost = listPrice * factor;
		if (!Number.isFinite(factor) || !Number.isFinite(marginalUnitCost))
			throw new TypeError("invalid build cost estimate");
		const accounts = balances.get(observation.providerId) ?? new Map();
		accounts.set(sku, {
			...accounts.get(sku),
			marginalUnitCost,
			meteredUnitFactor: factor,
		});
		balances.set(observation.providerId, accounts);
	}
	const result = {
		seq,
		buildId,
		balances: Object.fromEntries(
			[...balances].map(([provider, accounts]) => [
				provider,
				Object.fromEntries(accounts),
			]),
		),
	};
	const digestInput: JsonValue = JSON.parse(JSON.stringify(result));
	return { ...result, balanceHash: digestRef(sortKeys(digestInput)) };
}

function rankCandidate(
	record: ExecutionHostRecord,
	ledgerView: CreditLedgerView,
	units: number,
): DispatchCandidate {
	const sku = CATEGORY_SKUS[record.category];
	const quote = ledgerView.balances?.[record.id]?.[sku] ?? {};
	const freeHeadroom = quote.freeHeadroom ?? 0;
	const factor = quote.meteredUnitFactor ?? 1;
	const freeUnits =
		factor === 0 ? Number.POSITIVE_INFINITY : freeHeadroom / factor;
	const listUnitCost = quote.marginalUnitCost ?? declaredUnitCost(record, sku);
	if (
		!Number.isFinite(freeHeadroom) ||
		freeHeadroom < 0 ||
		!Number.isFinite(factor) ||
		factor < 0 ||
		!Number.isFinite(listUnitCost) ||
		listUnitCost < 0
	)
		throw new TypeError(`invalid cost input for ${record.id}`);
	const paidUnits = Math.max(0, units - freeUnits);
	const totalCost = Number((paidUnits * listUnitCost).toFixed(10));
	if (!Number.isFinite(totalCost))
		throw new RangeError(`cost estimate overflow for ${record.id}`);
	return {
		providerId: record.id,
		category: record.category,
		effectiveMarginalCost: freeUnits >= units ? 0 : listUnitCost,
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
	if (!Number.isFinite(units) || units <= 0)
		throw new RangeError("units must be a positive finite number");
	if (
		ledgerView.buildId !== undefined &&
		ledgerView.buildId !== request.buildId
	)
		throw new TypeError("ledger view belongs to another build");

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
