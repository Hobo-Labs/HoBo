import { createHash } from "node:crypto";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonBag,
	type JsonObject,
	type JsonValue,
	parseJsonObject,
} from "./json.js";

export const CREDIT_DISPATCH_SCHEMA = "hobo.dispatcher/credit";

export const DISPATCH_EVENTS = Object.freeze({
	DispatchDecided: "dispatch.Decided",
	MatchDecided: "match.Decided",
	ReservationReserved: "dispatch.ReservationReserved",
	ReservationStarted: "dispatch.ReservationStarted",
	ReservationConfirmed: "dispatch.ReservationConfirmed",
	ReservationReleased: "dispatch.ReservationReleased",
	ReservationExpired: "dispatch.ReservationExpired",
	LedgerTimeAdvanced: "dispatch.LedgerTimeAdvanced",
} as const);

export type DispatchCategory = "runner" | "build-machine" | "traffic-backend";
export type DispatchObjective = "maximize-credits";
export type CreditFacts = "present" | "present-empty" | "missing" | "invalid";

const CATEGORY_DIMENSIONS: Readonly<Record<DispatchCategory, string>> =
	Object.freeze({
		runner: "runner.minutes",
		"build-machine": "build.minutes",
		"traffic-backend": "traffic.requests",
	});
const LARGE_SCORE = Number.MAX_SAFE_INTEGER;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;

export interface CreditGrant {
	creditId: string;
	freeHeadroom: number;
	expiresAt?: string;
	windowEnd?: string;
}

export interface CreditAccount {
	providerId: string;
	dimension: string;
	currency?: string;
	listUnitCost?: number;
	freeHeadroom?: number;
	rateHeadroom?: number;
	concurrencyHeadroom?: number;
	budgetCap?: number;
	spendToDate?: number;
	reservedUnits?: number;
	reservedCost?: number;
	credits?: CreditGrant[];
}

export interface CreditLedgerView {
	view: "CreditLedgerView";
	seq: number;
	digest?: string;
	balanceHash?: string;
	asOf?: string;
	accounts: CreditAccount[];
	reservations?: DispatchReservation[];
}

export interface DispatchReservation {
	reservationId: string;
	providerId: string;
	dimension: string;
	units: number;
	expectedSeq: number;
	committedSeq: number;
	status: "pending" | "running" | "confirmed" | "released" | "expired";
	expiresAt?: string | null;
	confirmedSeq?: number;
	releasedSeq?: number;
	releaseReason?: string;
	providerUsageSeq?: number;
	startedSeq?: number;
	consumption?: ReservedConsumption;
	reservedCost?: number;
	actualCost?: number;
	commandHash?: string;
	unitCost?: number;
	switchingCost?: number;
	dispatchRequestHash?: string;
	decisionInputJson?: string;
	estimatedCost?: number;
	usageEvidenceRef?: string;
}

interface ReservedConsumption {
	freeHeadroom: number;
	credits: { creditId: string; units: number }[];
	rateUnits?: number;
	concurrencySlots?: number;
}

type InputObject = JsonObject;

interface ParsedCandidate {
	readonly category: string;
	readonly definitionId: string;
	readonly dimension: string;
	readonly id?: string;
	readonly listUnitCost: number;
	readonly priority?: number;
	readonly providerId: string;
	readonly region?: string | undefined;
	readonly registered: boolean;
	readonly resourceType?: string;
	readonly source: InputObject;
	readonly specificity?: number;
	readonly switchingCost: number;
}

interface CreditSummary {
	readonly budgetHeadroom: number;
	readonly concurrencyHeadroom: number;
	readonly freeHeadroom: number;
	readonly listUnitCost: number;
	readonly rateHeadroom: number;
	readonly status: CreditFacts;
	readonly valid: boolean;
}

interface RankedCandidate extends ParsedCandidate {
	readonly baseCost: number;
	readonly budgetExceeded: boolean;
	readonly creditFacts: CreditFacts;
	readonly decisionVector: readonly number[];
	readonly effectiveMarginalCost: number;
	readonly eligible: boolean;
	readonly freeUnits: number;
	readonly nextCreditExpiresAt: string | null;
	readonly objectiveScore: number;
	readonly paidUnits: number;
	readonly rankVector: readonly (number | string)[];
	readonly rationale: string;
	readonly rejectionReason: string | undefined;
	readonly totalCost: number;
}

interface RankedCandidateWithRank extends RankedCandidate {
	readonly rank: number;
}

interface ReservationAttempt {
	readonly actualSeq?: number;
	readonly committedSeq?: number;
	readonly ledgerView: CreditLedgerView;
	readonly ok: boolean;
	readonly status: string;
}

export interface ReservationLedgerPort {
	reserve(request: ReserveRequest): ReservationAttempt;
	snapshot(): CreditLedgerView;
}

export interface DispatchProviderInput {
	id?: string;
	providerId?: string;
	category: DispatchCategory;
	registered?: boolean;
	dimension?: string;
	listUnitCost?: number;
	switchingCost?: number;
}

export interface PlacementCandidateInput {
	definitionId?: string;
	dimension: string;
	id?: string;
	listUnitCost?: number;
	priority?: number;
	providerId?: string;
	region?: string;
	registered?: boolean;
	resourceType: string;
	specificity?: number;
	switchingCost?: number;
}

export interface ReserveRequest {
	decisionInputJson?: string;
	dimension: string;
	dispatchRequestHash?: string;
	estimatedCost?: number;
	expectedSeq: number;
	expiresAt?: string | null;
	providerId: string;
	reservationId: string;
	switchingCost?: number;
	unitCost?: number;
	units?: number;
}

interface StartRequest {
	committedSeq?: number;
	reservationId: string;
}

interface ConfirmRequest {
	actualCost?: number;
	providerUsageSeq?: number;
	reservationId: string;
	usageEvidenceRef?: string;
	usageFinalized?: boolean;
}

interface ReleaseRequest {
	reason?: string;
	reservationId: string;
}

interface ExpireRequest {
	now: string;
}

export interface HysteresisInput {
	incumbentProviderId: string;
	minimumSavings: number;
	dwellWindow: string;
	observedAt: string;
	savingsSince?: string;
	challengerProviderId?: string;
}

export interface DispatchRequest {
	category: DispatchCategory;
	dispatchId: string;
	hysteresis?: HysteresisInput | null;
	incumbentProviderId?: string;
	ledgerView: CreditLedgerView;
	objective?: DispatchObjective;
	registry: DispatcherRegistry | DispatchProviderInput[];
	reservationId?: string;
	units?: number;
}

export interface DispatchAndReserveRequest
	extends Omit<DispatchRequest, "ledgerView"> {
	estimatedCost?: number;
	ledgerView?: CreditLedgerView;
	maxAttempts?: number;
	reservationExpiresAt?: string | null;
	reservationLedger: ReservationLedgerPort;
}

export interface DispatchReplayInput {
	candidates: DispatchProviderInput[];
	category: DispatchCategory;
	dispatchId: string;
	hysteresis?: HysteresisInput | null;
	incumbentProviderId?: string;
	ledgerView: CreditLedgerView;
	objective: DispatchObjective;
	reservationId: string;
	units: number;
}

export interface PlacementRequest {
	candidates?: readonly PlacementCandidateInput[];
	catalogContentHash?: string;
	incumbentProviderId?: string;
	ledgerView: CreditLedgerView;
	objective?: DispatchObjective;
	resourceId: string;
	resourceType: string;
	units?: number;
}

export interface DispatchFact<T = object> {
	type: string;
	data: T;
}

export interface DispatchDecidedData {
	dispatchId: string;
	category: DispatchCategory;
	selectedProvider: string;
	objective: DispatchObjective;
	ledgerInput: {
		view: "CreditLedgerView";
		seq: number;
		reservationId: string;
		balanceHash: string;
	};
	candidates: {
		provider: string;
		effectiveMarginalCost: number;
		rationale: string;
	}[];
}

export function createDispatcherRegistry(
	providers: readonly (DispatchProviderInput | JsonValue)[] = [],
): DispatcherRegistry {
	if (!Array.isArray(providers)) {
		throw new TypeError("providers must be an array");
	}

	const records = providers.map(parseDispatchProvider);
	const byCategory = new Map<string, typeof records>();
	const providerKeys = new Set<string>();
	for (const record of records) {
		const key = canonicalJson([record.category, record.providerId]);
		if (providerKeys.has(key))
			throw new TypeError("duplicate dispatcher provider in category");
		providerKeys.add(key);
		if (!record.registered) continue;
		const bucket = byCategory.get(record.category) ?? [];
		bucket.push(record);
		byCategory.set(record.category, bucket);
	}

	return {
		schema: `${CREDIT_DISPATCH_SCHEMA}.registry`,
		records,
		byCategory,
	};
}

export interface DispatcherRegistry {
	readonly schema: string;
	readonly records: ParsedCandidate[];
	readonly byCategory: Map<string, ParsedCandidate[]>;
}

function decideDispatchInput(request: DispatchRequest) {
	if (!isJsonObject(request)) throw new TypeError("request must be an object");
	const category = requireCategory(request.category);
	const objective = requireObjective(request.objective ?? "maximize-credits");
	const dispatchId = requireString(request.dispatchId, "request.dispatchId");
	const units = requirePositiveNumber(request.units ?? 1, "request.units");
	const registry = parseRegistry(request.registry);
	const candidates = registry.byCategory.get(category) ?? [];
	const ledgerView = parseCreditLedgerView(request.ledgerView);
	const hysteresisInput = parseHysteresis(request.hysteresis);
	const incumbentProviderId =
		request.incumbentProviderId === undefined
			? hysteresisInput?.incumbentProviderId
			: requireString(
					request.incumbentProviderId,
					"request.incumbentProviderId",
				);
	const reservationId = requireString(
		request.reservationId ?? `reservation-intent-${dispatchId}`,
		"request.reservationId",
	);

	if (candidates.length === 0) {
		return failedDecision({
			objective,
			reason: `no registered ${category} candidates`,
		});
	}

	const ranked = rankCreditCandidates({
		candidates,
		ledgerView,
		units,
		incumbentProviderId,
	});
	const eligible = ranked.filter((candidate) => candidate.eligible);
	if (eligible.length === 0) {
		return {
			...failedDecision({
				objective,
				reason: "no eligible candidates within budget and capacity",
			}),
			ranking: publicDispatchRanking(ranked),
		};
	}
	const hysteresis = applyHysteresis(eligible, hysteresisInput);
	const finalRanked = [
		...hysteresis.ranked,
		...ranked.filter((candidate) => !candidate.eligible),
	];
	const winner = finalRanked[0];
	if (!winner) throw new TypeError("dispatcher produced no ranked candidate");
	const dispatchEvent: DispatchFact<DispatchDecidedData> = {
		type: DISPATCH_EVENTS.DispatchDecided,
		data: {
			dispatchId,
			category,
			selectedProvider: winner.providerId,
			objective,
			ledgerInput: {
				view: "CreditLedgerView",
				seq: ledgerView.seq,
				reservationId,
				balanceHash: ledgerBalanceHash(ledgerView),
			},
			candidates: finalRanked.map((candidate) => ({
				provider: candidate.providerId,
				effectiveMarginalCost: candidate.effectiveMarginalCost,
				rationale: candidate.rationale,
			})),
		},
	};

	return {
		ok: true as const,
		schema: CREDIT_DISPATCH_SCHEMA,
		objective,
		selectedProvider: winner.providerId,
		ranking: publicDispatchRanking(finalRanked),
		hysteresis: hysteresis.public,
		dispatchEvent,
		replayInput: {
			category,
			dispatchId,
			objective,
			units,
			incumbentProviderId,
			hysteresis: hysteresisInput,
			reservationId,
			ledgerView: replayLedgerView(ledgerView),
			candidates: registry.records.map((record) => clone(record.source)),
		},
	};
}

export function decideCreditDispatch(request: DispatchRequest) {
	return decideDispatchInput(request);
}

function replayLedgerView(ledgerView: CreditLedgerView): CreditLedgerView {
	if (
		!ledgerView.reservations?.some(
			(reservation) => reservation.decisionInputJson !== undefined,
		)
	)
		return clone(ledgerView);
	return {
		...clone(ledgerView),
		reservations: [],
		balanceHash: ledgerBalanceHash(ledgerView),
	};
}

export function createReservationLedger(
	initialLedgerView: CreditLedgerView | JsonValue,
) {
	let current = parseCreditLedgerView(initialLedgerView);
	const eventLog: DispatchFact[] = [];

	function releaseReservation({
		reservationId,
		reason,
		eventType,
	}: {
		readonly reservationId: string;
		readonly reason: string;
		readonly eventType: string;
	}) {
		const next = clone(current);
		const reservation = findReservation(next, reservationId);
		if (reservation?.status !== "pending") {
			return {
				ok: false as const,
				status: "not-releasable",
				reservationId,
				ledgerView: clone(current),
			};
		}

		const account = findLedgerAccount(
			next,
			reservation.providerId,
			reservation.dimension,
		);
		if (account) {
			restoreReservedFreeHeadroom(account, reservation.consumption);
			account.reservedCost = roundCost(
				Math.max(
					0,
					(account.reservedCost ?? 0) - (reservation.reservedCost ?? 0),
				),
			);
			if (account.rateHeadroom !== undefined)
				account.rateHeadroom = roundQuantity(
					account.rateHeadroom + (reservation.consumption?.rateUnits ?? 0),
				);
			if (account.concurrencyHeadroom !== undefined)
				account.concurrencyHeadroom +=
					reservation.consumption?.concurrencySlots ?? 0;
			account.reservedUnits = roundQuantity(
				Math.max(0, (account.reservedUnits ?? 0) - reservation.units),
			);
		}
		const committedSeq = next.seq + 1;
		reservation.status =
			eventType === DISPATCH_EVENTS.ReservationExpired ? "expired" : "released";
		reservation.releaseReason = reason;
		reservation.releasedSeq = committedSeq;
		next.seq = committedSeq;
		current = next;
		eventLog.push(
			reservationFact(eventType, reservation, {
				ledgerSeq: current.seq,
				reason,
			}),
		);

		return {
			ok: true as const,
			status: reservation.status,
			reservationId,
			committedSeq,
			reservation: clone(reservation),
			ledgerView: clone(current),
		};
	}

	return {
		snapshot() {
			return clone(current);
		},
		events() {
			return clone(eventLog);
		},
		reserve(request: ReserveRequest) {
			if (!isJsonObject(request))
				throw new TypeError("request must be an object");
			const providerId = requireString(
				request.providerId,
				"request.providerId",
			);
			const dimension = requireString(request.dimension, "request.dimension");
			const reservationId = requireString(
				request.reservationId,
				"request.reservationId",
			);
			const units = requirePositiveNumber(request.units ?? 1, "request.units");
			const expectedSeq = requireNonNegativeInteger(
				request.expectedSeq,
				"request.expectedSeq",
			);
			const expiresAt = optionalInstant(request.expiresAt, "request.expiresAt");
			const accountAtRead = findLedgerAccount(current, providerId, dimension);
			if (
				accountAtRead?.budgetCap !== undefined &&
				accountAtRead.listUnitCost === undefined &&
				request.unitCost === undefined &&
				request.estimatedCost === undefined
			)
				return {
					ok: false as const,
					status: "ineligible",
					reason: "hard-budget-price-missing",
					reservationId,
					ledgerView: clone(current),
				};
			const unitCost = nonNegativeNumber(
				request.unitCost ?? accountAtRead?.listUnitCost,
				"request.unitCost",
				0,
			);
			const switchingCost = nonNegativeNumber(
				request.switchingCost,
				"request.switchingCost",
				0,
			);
			const estimatedCost = nonNegativeNumber(
				request.estimatedCost,
				"request.estimatedCost",
				0,
			);
			const commandHash = stableHash({
				providerId,
				dimension,
				units,
				unitCost,
				switchingCost,
				estimatedCost,
				expiresAt,
			});
			const existing = findReservation(current, reservationId);
			if (existing) {
				if (existing.commandHash !== commandHash)
					return {
						ok: false as const,
						status: "reservation-id-conflict",
						reservationId,
						ledgerView: clone(current),
					};
				if (existing.status !== "pending")
					return {
						ok: false as const,
						status: "reservation-terminal",
						reservationId,
						reservation: clone(existing),
						ledgerView: clone(current),
					};
				if (
					existing.expiresAt &&
					current.asOf &&
					Date.parse(existing.expiresAt) <= Date.parse(current.asOf)
				)
					return {
						ok: false as const,
						status: "reservation-expired",
						reservationId,
						ledgerView: clone(current),
					};
				return {
					ok: true as const,
					status: "reserved",
					replayed: true,
					reservationId,
					providerId,
					dimension,
					units,
					expectedSeq: existing.expectedSeq,
					committedSeq: existing.committedSeq,
					reservation: clone(existing),
					ledgerView: clone(current),
				};
			}
			if (
				expiresAt &&
				current.asOf &&
				Date.parse(expiresAt) <= Date.parse(current.asOf)
			)
				return {
					ok: false as const,
					status: "reservation-expired",
					reservationId,
					ledgerView: clone(current),
				};

			if (expectedSeq !== current.seq) {
				return {
					ok: false as const,
					status: "cas-conflict",
					reservationId,
					providerId,
					dimension,
					expectedSeq,
					actualSeq: current.seq,
					ledgerView: clone(current),
				};
			}

			const next = clone(current);
			const account = findLedgerAccount(next, providerId, dimension);
			const priced = rankCreditCandidate({
				candidate: {
					category: "reservation",
					definitionId: providerId,
					providerId,
					dimension,
					listUnitCost: unitCost,
					registered: true,
					source: {},
					switchingCost,
				},
				ledgerView: current,
				units,
				incumbentProviderId: undefined,
				chargeSwitching: true,
			});
			if (!priced.eligible)
				return {
					ok: false as const,
					status: "ineligible",
					reason: priced.rejectionReason,
					reservationId,
					providerId,
					dimension,
					ledgerView: clone(current),
				};
			const reservedCost = Math.max(priced.totalCost, estimatedCost);
			if (account && reservedCost > budgetHeadroomFor(account))
				return {
					ok: false as const,
					status: "ineligible",
					reason: "budget-cap-exceeded",
					reservationId,
					providerId,
					dimension,
					ledgerView: clone(current),
				};
			let consumption: ReservedConsumption = { freeHeadroom: 0, credits: [] };
			if (account) {
				consumption = consumeReservedFreeHeadroom(
					account,
					priced.freeUnits,
					current.asOf,
				);
				if (account.rateHeadroom !== undefined) {
					account.rateHeadroom = roundQuantity(account.rateHeadroom - units);
					consumption.rateUnits = units;
				}
				if (account.concurrencyHeadroom !== undefined) {
					account.concurrencyHeadroom -= 1;
					consumption.concurrencySlots = 1;
				}
				account.reservedCost = roundCost(
					(account.reservedCost ?? 0) + reservedCost,
				);
				account.reservedUnits = roundQuantity(
					(account.reservedUnits ?? 0) + units,
				);
			}
			const committedSeq = next.seq + 1;
			const reservation: DispatchReservation = {
				reservationId,
				providerId,
				dimension,
				units,
				expectedSeq,
				committedSeq,
				status: "pending",
				expiresAt,
				consumption,
				reservedCost,
				estimatedCost,
				unitCost,
				switchingCost,
				commandHash,
			};
			if (request.dispatchRequestHash !== undefined)
				reservation.dispatchRequestHash = requireString(
					request.dispatchRequestHash,
					"request.dispatchRequestHash",
				);
			if (request.decisionInputJson !== undefined)
				reservation.decisionInputJson = requireString(
					request.decisionInputJson,
					"request.decisionInputJson",
				);
			next.seq = committedSeq;
			next.reservations = [
				...(Array.isArray(next.reservations) ? next.reservations : []),
				reservation,
			];
			current = next;
			eventLog.push(
				reservationFact(DISPATCH_EVENTS.ReservationReserved, reservation, {
					ledgerSeq: current.seq,
				}),
			);

			return {
				ok: true as const,
				status: "reserved",
				reservationId,
				providerId,
				dimension,
				units,
				expectedSeq,
				committedSeq,
				reservation: clone(reservation),
				ledgerView: clone(current),
			};
		},
		start(request: StartRequest) {
			if (!isJsonObject(request))
				throw new TypeError("request must be an object");
			const reservationId = requireString(
				request.reservationId,
				"request.reservationId",
			);
			const reservation = findReservation(current, reservationId);
			if (
				!reservation ||
				(reservation.status !== "pending" && reservation.status !== "running")
			)
				return {
					ok: false as const,
					status: "not-startable",
					reservationId,
					ledgerView: clone(current),
				};
			if (
				request.committedSeq !== undefined &&
				request.committedSeq !== reservation.committedSeq
			)
				return {
					ok: false as const,
					status: "reservation-fence-mismatch",
					reservationId,
					ledgerView: clone(current),
				};
			if (reservation.status === "running")
				return {
					ok: true as const,
					status: "running",
					replayed: true,
					reservation: clone(reservation),
					ledgerView: clone(current),
				};
			if (
				reservation.expiresAt &&
				current.asOf &&
				Date.parse(reservation.expiresAt) <= Date.parse(current.asOf)
			)
				return {
					ok: false as const,
					status: "reservation-expired",
					reservationId,
					ledgerView: clone(current),
				};
			const next = clone(current);
			const started = findReservation(next, reservationId);
			if (!started)
				throw new TypeError("reservation disappeared from snapshot");
			started.status = "running";
			started.startedSeq = next.seq + 1;
			next.seq += 1;
			current = next;
			eventLog.push(
				reservationFact(DISPATCH_EVENTS.ReservationStarted, started, {
					ledgerSeq: current.seq,
				}),
			);
			return {
				ok: true as const,
				status: "running",
				reservation: clone(started),
				ledgerView: clone(current),
			};
		},
		confirm(request: ConfirmRequest) {
			if (!isJsonObject(request))
				throw new TypeError("request must be an object");
			const reservationId = requireString(
				request.reservationId,
				"request.reservationId",
			);
			const next = clone(current);
			const reservation = findReservation(next, reservationId);
			if (
				!reservation ||
				(reservation.status !== "pending" && reservation.status !== "running")
			) {
				return {
					ok: false as const,
					status: "not-confirmable",
					reservationId,
					ledgerView: clone(current),
				};
			}
			if (
				reservation.status === "running" &&
				(request.usageFinalized !== true ||
					request.actualCost === undefined ||
					!isJsonString(request.usageEvidenceRef) ||
					request.usageEvidenceRef.length === 0)
			)
				return {
					ok: false as const,
					status: "usage-not-final",
					reservationId,
					ledgerView: clone(current),
				};
			if (
				reservation.status === "pending" &&
				reservation.expiresAt &&
				current.asOf &&
				Date.parse(reservation.expiresAt) <= Date.parse(current.asOf)
			)
				return {
					ok: false as const,
					status: "reservation-expired",
					reservationId,
					ledgerView: clone(current),
				};

			const committedSeq = next.seq + 1;
			const actualCost = nonNegativeNumber(
				request.actualCost,
				"request.actualCost",
				reservation.reservedCost ?? 0,
			);
			const account = findLedgerAccount(
				next,
				reservation.providerId,
				reservation.dimension,
			);
			if (account) {
				account.reservedCost = roundCost(
					Math.max(
						0,
						(account.reservedCost ?? 0) - (reservation.reservedCost ?? 0),
					),
				);
				account.spendToDate = roundCost(
					(account.spendToDate ?? 0) + actualCost,
				);
				account.reservedUnits = roundQuantity(
					Math.max(0, (account.reservedUnits ?? 0) - reservation.units),
				);
				if (account.concurrencyHeadroom !== undefined)
					account.concurrencyHeadroom +=
						reservation.consumption?.concurrencySlots ?? 0;
			}
			reservation.status = "confirmed";
			reservation.actualCost = actualCost;
			if (request.usageEvidenceRef !== undefined)
				reservation.usageEvidenceRef = requireString(
					request.usageEvidenceRef,
					"request.usageEvidenceRef",
				);
			reservation.confirmedSeq = committedSeq;
			if (request.providerUsageSeq !== undefined) {
				reservation.providerUsageSeq = requireNonNegativeInteger(
					request.providerUsageSeq,
					"request.providerUsageSeq",
				);
			}
			next.seq = committedSeq;
			current = next;
			eventLog.push(
				reservationFact(DISPATCH_EVENTS.ReservationConfirmed, reservation, {
					ledgerSeq: current.seq,
					...(reservation.providerUsageSeq === undefined
						? undefined
						: { providerUsageSeq: reservation.providerUsageSeq }),
				}),
			);

			return {
				ok: true as const,
				status: "confirmed",
				reservationId,
				committedSeq,
				reservation: clone(reservation),
				budgetExceeded:
					account?.budgetCap !== undefined &&
					(account.spendToDate ?? 0) + (account.reservedCost ?? 0) >
						account.budgetCap,
				ledgerView: clone(current),
			};
		},
		release(request: ReleaseRequest) {
			if (!isJsonObject(request))
				throw new TypeError("request must be an object");
			const reservationId = requireString(
				request.reservationId,
				"request.reservationId",
			);
			const reason = requireString(
				request.reason ?? "released",
				"request.reason",
			);
			return releaseReservation({
				reservationId,
				reason,
				eventType: DISPATCH_EVENTS.ReservationReleased,
			});
		},
		expire(request: ExpireRequest) {
			if (!isJsonObject(request))
				throw new TypeError("request must be an object");
			const now = requireInstant(request.now, "request.now");
			if (current.asOf && Date.parse(now) < Date.parse(current.asOf))
				throw new TypeError("request.now must not precede ledger.asOf");
			if (!current.asOf || Date.parse(now) > Date.parse(current.asOf)) {
				current = { ...current, asOf: now, seq: current.seq + 1 };
				eventLog.push({
					type: DISPATCH_EVENTS.LedgerTimeAdvanced,
					data: { asOf: now, ledgerSeq: current.seq },
				});
			}
			const expiredIds = (current.reservations ?? [])
				.filter((reservation) => reservation.status === "pending")
				.filter(
					(reservation) =>
						reservation.expiresAt &&
						Date.parse(reservation.expiresAt) <= Date.parse(now),
				)
				.map((reservation) => reservation.reservationId);
			const releases = expiredIds.map((reservationId) =>
				releaseReservation({
					reservationId,
					reason: "expired",
					eventType: DISPATCH_EVENTS.ReservationExpired,
				}),
			);

			return {
				released: releases.filter((release) => release.ok).length,
				releases,
				ledgerView: clone(current),
			};
		},
	};
}

export type ReservationLedger = ReturnType<typeof createReservationLedger>;

export function decideAndReserveDispatch(request: DispatchAndReserveRequest) {
	if (!isJsonObject(request)) throw new TypeError("request must be an object");
	if (!isReservationLedger(request.reservationLedger)) {
		throw new TypeError(
			"request.reservationLedger must be a reservation ledger",
		);
	}
	const reservationLedger = request.reservationLedger;
	const objective = requireObjective(request.objective ?? "maximize-credits");
	const dispatchId = requireString(request.dispatchId, "request.dispatchId");
	const reservationId =
		request.reservationId === undefined
			? `reserve-${dispatchId}`
			: requireString(request.reservationId, "request.reservationId");
	const units = requirePositiveNumber(request.units ?? 1, "request.units");

	const maxAttempts = requirePositiveInteger(
		request.maxAttempts ?? 3,
		"request.maxAttempts",
	);
	const registry = parseRegistry(request.registry);
	const requestHash = stableHash({
		category: requireCategory(request.category),
		dispatchId,
		objective,
		units,
		estimatedCost: nonNegativeNumber(
			request.estimatedCost,
			"request.estimatedCost",
			0,
		),
		incumbentProviderId: request.incumbentProviderId,
		hysteresis: parseHysteresis(request.hysteresis),
		reservationExpiresAt: optionalInstant(
			request.reservationExpiresAt,
			"request.reservationExpiresAt",
		),
		providers: registry.records.map((record) => record.source),
	});
	const existingSnapshot = reservationLedger.snapshot();
	const existing = findReservation(existingSnapshot, reservationId);
	if (existing) {
		if (
			existing.dispatchRequestHash !== requestHash ||
			!existing.decisionInputJson
		)
			return failedDecision({
				objective,
				reason: "reservation-id-conflict",
			});
		if (
			existing.status !== "pending" ||
			(existing.expiresAt &&
				existingSnapshot.asOf &&
				Date.parse(existing.expiresAt) <= Date.parse(existingSnapshot.asOf))
		)
			return failedDecision({
				objective,
				reason: "reservation-terminal-or-expired",
			});
		const decision = replayDispatchDecision(
			parseJsonObject(existing.decisionInputJson),
		);
		return {
			...decision,
			reservation: {
				ok: true,
				status: "reserved",
				replayed: true,
				reservationId: existing.reservationId,
				committedSeq: existing.committedSeq,
				reservation: existing,
				ledgerView: existingSnapshot,
			},
			attempts: [],
		};
	}
	let ledgerView = request.ledgerView
		? parseCreditLedgerView(request.ledgerView)
		: reservationLedger.snapshot();
	const attempts: {
		attempt: number;
		status: string;
		selectedProvider: string;
		expectedSeq: number;
		actualSeq: number;
	}[] = [];

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const decision = decideDispatchInput({
			...request,
			registry,
			ledgerView,
			reservationId,
		});
		if (!decision.ok) {
			return {
				...decision,
				attempts,
			};
		}

		const selectedRecord = registry.records.find(
			(record) => record.providerId === decision.selectedProvider,
		);
		const selectedCost = decision.ranking.find(
			(candidate) => candidate.providerId === decision.selectedProvider,
		);
		const dimension =
			selectedRecord?.dimension ??
			CATEGORY_DIMENSIONS[decision.dispatchEvent.data.category];
		const reservation = reservationLedger.reserve({
			providerId: decision.selectedProvider,
			dimension,
			units,
			expectedSeq: ledgerView.seq,
			reservationId: decision.dispatchEvent.data.ledgerInput.reservationId,
			...(request.reservationExpiresAt === undefined
				? undefined
				: { expiresAt: request.reservationExpiresAt }),
			...(selectedRecord?.listUnitCost === undefined
				? undefined
				: { unitCost: selectedRecord.listUnitCost }),
			switchingCost: selectedCost?.switchingCost ?? 0,
			...(request.estimatedCost === undefined
				? undefined
				: { estimatedCost: request.estimatedCost }),
			dispatchRequestHash: requestHash,
			decisionInputJson: JSON.stringify(decision.replayInput),
		});
		attempts.push({
			attempt,
			status: reservation.status,
			selectedProvider: decision.selectedProvider,
			expectedSeq: ledgerView.seq,
			actualSeq:
				reservation.actualSeq ?? reservation.committedSeq ?? ledgerView.seq,
		});

		if (reservation.ok) {
			return {
				...decision,
				reservation,
				attempts,
			};
		}
		if (reservation.status !== "cas-conflict")
			return {
				...failedDecision({
					objective: decision.objective,
					reason: `reservation refused: ${reservation.status}`,
				}),
				reservation,
				attempts,
			};

		ledgerView = reservation.ledgerView;
	}

	return {
		ok: false as const,
		schema: CREDIT_DISPATCH_SCHEMA,
		objective,
		reason: `reservation CAS failed after ${maxAttempts} attempts`,
		ranking: [],
		attempts,
	};
}

export function replayDispatchDecision(
	replayInput: DispatchReplayInput | JsonObject,
) {
	const parsed = cloneAsJson(replayInput);
	if (!isJsonObject(parsed)) {
		throw new TypeError("replayInput must be an object");
	}
	const incumbentProviderId =
		parsed.incumbentProviderId === undefined
			? undefined
			: requireString(
					parsed.incumbentProviderId,
					"replayInput.incumbentProviderId",
				);
	return decideDispatchInput({
		category: requireCategory(parsed.category),
		dispatchId: requireString(parsed.dispatchId, "replayInput.dispatchId"),
		hysteresis: parseHysteresis(parsed.hysteresis),
		...(incumbentProviderId === undefined
			? undefined
			: { incumbentProviderId }),
		ledgerView: parseCreditLedgerView(parsed.ledgerView ?? null),
		objective: requireObjective(parsed.objective),
		registry: createDispatcherRegistry(
			requireArray(parsed.candidates, "replayInput.candidates"),
		),
		reservationId: requireString(
			parsed.reservationId,
			"replayInput.reservationId",
		),
		units: requirePositiveNumber(parsed.units, "replayInput.units"),
	});
}

export function decidePlacement(request: PlacementRequest) {
	if (!isJsonObject(request)) throw new TypeError("request must be an object");
	const objective = requireObjective(request.objective ?? "maximize-credits");
	const resourceId = requireString(request.resourceId, "request.resourceId");
	const resourceType = requireString(
		request.resourceType,
		"request.resourceType",
	);
	const units = requirePositiveNumber(request.units ?? 1, "request.units");
	const ledgerView = parseCreditLedgerView(request.ledgerView);
	const rejectedCandidates: { definitionId: string; reason: string }[] = [];
	const candidates: ParsedCandidate[] = [];

	if (request.candidates !== undefined && !Array.isArray(request.candidates)) {
		throw new TypeError("request.candidates must be an array");
	}
	for (const candidate of request.candidates ?? []) {
		const parsed = parsePlacementCandidate(candidate);
		if (!parsed.registered) {
			rejectedCandidates.push({
				definitionId: parsed.definitionId,
				reason: "candidate is not registered",
			});
			continue;
		}
		if (parsed.resourceType !== resourceType) {
			rejectedCandidates.push({
				definitionId: parsed.definitionId,
				reason: `resourceType ${parsed.resourceType} does not match ${resourceType}`,
			});
			continue;
		}
		candidates.push(parsed);
	}

	if (candidates.length === 0) {
		return failedDecision({
			objective,
			reason: `no registered ${resourceType} placement candidates`,
			rejectedCandidates,
		});
	}

	const ranked = rankCreditCandidates({
		candidates,
		ledgerView,
		units,
		...(request.incumbentProviderId === undefined
			? undefined
			: {
					incumbentProviderId: requireString(
						request.incumbentProviderId,
						"request.incumbentProviderId",
					),
				}),
	});
	const winner = ranked.find((candidate) => candidate.eligible);
	if (!winner)
		return {
			...failedDecision({
				objective,
				reason: "no eligible placement candidates within budget and capacity",
				rejectedCandidates,
			}),
			ranking: publicPlacementRanking(ranked),
		};
	const tiedDefinitionIds = ranked
		.filter((candidate) => compareDecisionVector(candidate, winner) === 0)
		.map((candidate) => candidate.definitionId);
	const ranking = publicPlacementRanking(ranked);
	const matchEvent: DispatchFact = {
		type: DISPATCH_EVENTS.MatchDecided,
		data: {
			resourceId,
			winner: winner.definitionId,
			ranking,
			rejectedCandidates,
			objective,
			tie: tiedDefinitionIds.length > 1,
			catalogContentHash: parseHashRef(
				request.catalogContentHash ??
					stableHash({
						resourceType,
						candidates: candidates.map((candidate) => candidate.source),
					}),
			),
		},
	};

	return {
		ok: true as const,
		schema: CREDIT_DISPATCH_SCHEMA,
		objective,
		winner: winner.definitionId,
		selectedProvider: winner.providerId,
		ranking,
		rejectedCandidates,
		tiedDefinitionIds,
		matchEvent,
	};
}

function rankCreditCandidates({
	candidates,
	ledgerView,
	units,
	incumbentProviderId,
}: {
	readonly candidates: readonly ParsedCandidate[];
	readonly ledgerView: CreditLedgerView;
	readonly units: number;
	readonly incumbentProviderId?: string | undefined;
}): RankedCandidateWithRank[] {
	return candidates
		.map((candidate) =>
			rankCreditCandidate({
				candidate,
				ledgerView,
				units,
				incumbentProviderId,
			}),
		)
		.sort(compareRankedCandidates)
		.map((candidate, index) => ({
			...candidate,
			rank: index + 1,
		}));
}

function applyHysteresis(
	ranked: readonly RankedCandidateWithRank[],
	hysteresis: HysteresisInput | null,
) {
	if (!hysteresis) {
		return {
			ranked,
			public: {
				held: false,
				input: null,
			},
		};
	}

	const rawWinner = ranked[0];
	const incumbent = ranked.find(
		(candidate) => candidate.providerId === hysteresis.incumbentProviderId,
	);
	if (
		!rawWinner ||
		!incumbent ||
		rawWinner.providerId === incumbent.providerId
	) {
		return {
			ranked,
			public: {
				held: false,
				input: hysteresis,
				rawWinner: rawWinner?.providerId ?? null,
				incumbentProviderId: hysteresis.incumbentProviderId,
			},
		};
	}
	if (incumbent.budgetExceeded) {
		return {
			ranked,
			public: {
				held: false,
				input: hysteresis,
				rawWinner: rawWinner.providerId,
				incumbentProviderId: incumbent.providerId,
				reason: "incumbent-budget-exceeded",
			},
		};
	}

	const savings = roundCost(incumbent.totalCost - rawWinner.totalCost);
	const durationMs = dwellDurationMs(hysteresis.dwellWindow);
	const sustained =
		durationMs === 0 ||
		(hysteresis.challengerProviderId === rawWinner.providerId &&
			hysteresis.savingsSince !== undefined &&
			Date.parse(hysteresis.observedAt) - Date.parse(hysteresis.savingsSince) >=
				durationMs);
	if (savings >= hysteresis.minimumSavings && sustained) {
		return {
			ranked,
			public: {
				held: false,
				input: hysteresis,
				rawWinner: rawWinner.providerId,
				incumbentProviderId: incumbent.providerId,
				savings,
			},
		};
	}

	const heldIncumbent = {
		...incumbent,
		rationale: [
			incumbent.rationale,
			`hysteresis-held rawWinner=${rawWinner.providerId}`,
			`savings=${savings}`,
			`minimumSavings=${hysteresis.minimumSavings}`,
			`dwellWindow=${hysteresis.dwellWindow}`,
			`observedAt=${hysteresis.observedAt}`,
		].join("; "),
	};
	const heldChallenger = {
		...rawWinner,
		rationale: [
			rawWinner.rationale,
			`hysteresis-challenger-held incumbent=${incumbent.providerId}`,
			`savings=${savings}`,
			`minimumSavings=${hysteresis.minimumSavings}`,
		].join("; "),
	};
	const byProvider = new Map([
		[heldIncumbent.providerId, heldIncumbent],
		[heldChallenger.providerId, heldChallenger],
	]);
	const reranked = [
		heldIncumbent,
		...ranked
			.filter((candidate) => candidate.providerId !== incumbent.providerId)
			.map((candidate) => byProvider.get(candidate.providerId) ?? candidate),
	].map((candidate, index) => ({
		...candidate,
		rank: index + 1,
	}));

	return {
		ranked: reranked,
		public: {
			held: true,
			input: hysteresis,
			rawWinner: rawWinner.providerId,
			incumbentProviderId: incumbent.providerId,
			savings,
			reason:
				savings < hysteresis.minimumSavings
					? "savings-below-threshold"
					: "dwell-not-satisfied",
		},
	};
}

function rankCreditCandidate({
	candidate,
	ledgerView,
	units,
	incumbentProviderId,
	chargeSwitching = false,
}: {
	readonly candidate: ParsedCandidate;
	readonly ledgerView: CreditLedgerView;
	readonly units: number;
	readonly incumbentProviderId?: string | undefined;
	readonly chargeSwitching?: boolean;
}): RankedCandidate {
	const account = findLedgerAccount(
		ledgerView,
		candidate.providerId,
		candidate.dimension,
	);
	const credit = creditFactsFor(account, candidate, ledgerView.asOf);
	const listUnitCost = credit.listUnitCost;
	const freeUnits = credit.valid
		? Math.min(
				units,
				credit.freeHeadroom,
				credit.rateHeadroom,
				credit.concurrencyHeadroom > 0 ? LARGE_SCORE : 0,
			)
		: 0;
	const paidUnits = Math.max(0, units - freeUnits);
	const switchingCost =
		chargeSwitching ||
		(incumbentProviderId && candidate.providerId !== incumbentProviderId)
			? nonNegativeNumber(candidate.switchingCost, "candidate.switchingCost", 0)
			: 0;
	const baseCost = roundCost(paidUnits * listUnitCost);
	const totalCost = roundCost(baseCost + switchingCost);
	const budgetExceeded = totalCost > credit.budgetHeadroom;
	const hardBudgetInvalid =
		account !== null &&
		((account.budgetCap !== undefined && !credit.valid) ||
			(account.spendToDate !== undefined &&
				!optionalNonNegativeNumber(account.spendToDate)) ||
			(account.reservedCost !== undefined &&
				!optionalNonNegativeNumber(account.reservedCost)));
	const capacityExceeded =
		account !== null &&
		((account.rateHeadroom !== undefined &&
			(!optionalNonNegativeNumber(account.rateHeadroom) ||
				units > account.rateHeadroom)) ||
			(account.concurrencyHeadroom !== undefined &&
				(!Number.isInteger(account.concurrencyHeadroom) ||
					account.concurrencyHeadroom < 1)));
	const eligible = !budgetExceeded && !hardBudgetInvalid && !capacityExceeded;
	const rejectionReason = hardBudgetInvalid
		? "invalid-hard-budget-facts"
		: budgetExceeded
			? "budget-cap-exceeded"
			: capacityExceeded
				? "capacity-exceeded"
				: undefined;
	const effectiveMarginalCost = roundCost(totalCost / units);
	const freeButNotDepletable =
		credit.valid && credit.freeHeadroom > 0 && freeUnits === 0;
	const nextCreditExpiresAt = credit.valid
		? nextCreditExpiry(account, ledgerView.asOf)
		: null;
	const concurrencyScore = Number.isFinite(credit.concurrencyHeadroom)
		? credit.concurrencyHeadroom
		: LARGE_SCORE;
	const expiryScore =
		freeUnits > 0 && nextCreditExpiresAt
			? Date.parse(nextCreditExpiresAt)
			: LARGE_SCORE;
	const rationale = rationaleFor({
		credit,
		ledgerView,
		freeUnits,
		paidUnits,
		switchingCost,
		freeButNotDepletable,
	});

	return {
		...candidate,
		totalCost,
		baseCost,
		listUnitCost,
		effectiveMarginalCost,
		freeUnits: roundQuantity(freeUnits),
		paidUnits: roundQuantity(paidUnits),
		switchingCost,
		budgetExceeded,
		eligible,
		rejectionReason,
		creditFacts: credit.status,
		nextCreditExpiresAt,
		objectiveScore: effectiveMarginalCost,
		rationale,
		decisionVector: [
			eligible ? 0 : 1,
			effectiveMarginalCost,
			expiryScore,
			-concurrencyScore,
			listUnitCost,
			switchingCost,
		],
		rankVector: [
			eligible ? 0 : 1,
			effectiveMarginalCost,
			expiryScore,
			-concurrencyScore,
			listUnitCost,
			switchingCost,
			candidate.providerId,
			candidate.definitionId ?? candidate.providerId,
		],
	};
}

function creditFactsFor(
	account: CreditAccount | null,
	candidate: ParsedCandidate,
	asOf?: string,
): CreditSummary {
	if (!account) {
		return {
			status: "missing" as CreditFacts,
			valid: false,
			listUnitCost: nonNegativeNumber(
				candidate.listUnitCost,
				"candidate.listUnitCost",
				LARGE_SCORE,
			),
			freeHeadroom: 0,
			rateHeadroom: 0,
			concurrencyHeadroom: 0,
			budgetHeadroom: LARGE_SCORE,
		};
	}

	const listUnitCost = optionalNonNegativeNumber(account.listUnitCost)
		? account.listUnitCost
		: nonNegativeNumber(
				candidate.listUnitCost,
				"candidate.listUnitCost",
				LARGE_SCORE,
			);
	const freeHeadroom = freeHeadroomFor(account, asOf);
	const rateHeadroom =
		account.rateHeadroom === undefined ? LARGE_SCORE : account.rateHeadroom;
	const concurrencyHeadroom =
		account.concurrencyHeadroom === undefined
			? LARGE_SCORE
			: account.concurrencyHeadroom;
	const budgetHeadroom = budgetHeadroomFor(account);
	const valid = [
		listUnitCost,
		freeHeadroom,
		rateHeadroom,
		concurrencyHeadroom,
		budgetHeadroom,
	].every(optionalNonNegativeNumber);

	if (!valid) {
		return {
			status: "invalid" as CreditFacts,
			valid: false,
			listUnitCost: nonNegativeNumber(
				candidate.listUnitCost,
				"candidate.listUnitCost",
				LARGE_SCORE,
			),
			freeHeadroom: 0,
			rateHeadroom: 0,
			concurrencyHeadroom: 0,
			budgetHeadroom: LARGE_SCORE,
		};
	}

	return {
		status: (freeHeadroom > 0 ? "present" : "present-empty") as CreditFacts,
		valid: true,
		listUnitCost,
		freeHeadroom,
		rateHeadroom,
		concurrencyHeadroom,
		budgetHeadroom,
	};
}

function freeHeadroomFor(account: CreditAccount, asOf?: string) {
	if (
		account.freeHeadroom !== undefined &&
		!optionalNonNegativeNumber(account.freeHeadroom)
	)
		return Number.NaN;
	if (!Array.isArray(account.credits) || account.credits.length === 0)
		return account.freeHeadroom ?? 0;
	let allGrants = 0;
	let liveGrants = 0;
	for (const credit of account.credits) {
		if (!optionalNonNegativeNumber(credit?.freeHeadroom)) return Number.NaN;
		allGrants += credit.freeHeadroom;
		if (grantIsLive(credit, asOf)) liveGrants += credit.freeHeadroom;
	}
	if (account.freeHeadroom === undefined) return liveGrants;
	return Math.min(
		account.freeHeadroom,
		liveGrants + Math.max(0, account.freeHeadroom - allGrants),
	);
}

function grantIsLive(credit: CreditGrant, asOf?: string): boolean {
	const expiry = grantExpiry(credit);
	return (
		expiry === undefined ||
		(asOf !== undefined &&
			!Number.isNaN(Date.parse(expiry)) &&
			Date.parse(expiry) > Date.parse(asOf))
	);
}

function grantExpiry(credit: CreditGrant): string | undefined {
	return [credit.expiresAt, credit.windowEnd]
		.filter((value) => value !== undefined)
		.sort((left, right) => Date.parse(left) - Date.parse(right))[0];
}

function nextCreditExpiry(
	account: CreditAccount | null,
	asOf?: string,
): string | null {
	const expiries = (account?.credits ?? [])
		.filter(
			(credit) =>
				optionalNonNegativeNumber(credit?.freeHeadroom) &&
				credit.freeHeadroom > 0 &&
				grantIsLive(credit, asOf),
		)
		.map(grantExpiry)
		.filter(
			(value): value is string =>
				isJsonString(value) && !Number.isNaN(Date.parse(value)),
		)
		.sort(
			(left, right) =>
				Date.parse(left) - Date.parse(right) || left.localeCompare(right),
		);
	return expiries[0] ?? null;
}

function budgetHeadroomFor(account: CreditAccount): number {
	if (account.budgetCap === undefined && account.spendToDate === undefined) {
		return LARGE_SCORE;
	}
	const budgetCap =
		account.budgetCap === undefined ? LARGE_SCORE : account.budgetCap;
	const spendToDate =
		account.spendToDate === undefined ? 0 : account.spendToDate;
	if (
		!optionalNonNegativeNumber(budgetCap) ||
		!optionalNonNegativeNumber(spendToDate)
	) {
		return Number.NaN;
	}
	const reservedCost = account.reservedCost ?? 0;
	if (!optionalNonNegativeNumber(reservedCost)) return Number.NaN;
	return Math.max(0, budgetCap - spendToDate - reservedCost);
}

function compareRankedCandidates(
	left: RankedCandidate,
	right: RankedCandidate,
): number {
	for (
		let index = 0;
		index < Math.max(left.rankVector.length, right.rankVector.length);
		index += 1
	) {
		const leftValue = left.rankVector[index];
		const rightValue = right.rankVector[index];
		if (isJsonString(leftValue) || isJsonString(rightValue)) {
			const comparison = String(leftValue ?? "").localeCompare(
				String(rightValue ?? ""),
			);
			if (comparison !== 0) return comparison;
			continue;
		}
		if ((leftValue ?? LARGE_SCORE) < (rightValue ?? LARGE_SCORE)) return -1;
		if ((leftValue ?? LARGE_SCORE) > (rightValue ?? LARGE_SCORE)) return 1;
	}
	return 0;
}

function compareDecisionVector(
	left: RankedCandidate,
	right: RankedCandidate,
): number {
	for (
		let index = 0;
		index < Math.max(left.decisionVector.length, right.decisionVector.length);
		index += 1
	) {
		const leftValue = left.decisionVector[index] ?? LARGE_SCORE;
		const rightValue = right.decisionVector[index] ?? LARGE_SCORE;
		if (leftValue < rightValue) return -1;
		if (leftValue > rightValue) return 1;
	}
	return 0;
}

function publicDispatchRanking(ranked: readonly RankedCandidateWithRank[]) {
	return ranked.map((candidate) => ({
		providerId: candidate.providerId,
		category: candidate.category,
		dimension: candidate.dimension,
		rank: candidate.rank,
		effectiveMarginalCost: candidate.effectiveMarginalCost,
		totalCost: candidate.totalCost,
		freeUnits: candidate.freeUnits,
		paidUnits: candidate.paidUnits,
		switchingCost: candidate.switchingCost,
		budgetExceeded: candidate.budgetExceeded,
		...(!candidate.eligible
			? { eligible: false, rejectionReason: candidate.rejectionReason }
			: undefined),
		creditFacts: candidate.creditFacts,
		nextCreditExpiresAt: candidate.nextCreditExpiresAt,
		rationale: candidate.rationale,
	}));
}

function publicPlacementRanking(ranked: readonly RankedCandidateWithRank[]) {
	return ranked.map((candidate) => ({
		definitionId: candidate.definitionId,
		region: candidate.region,
		specificity: candidate.specificity,
		priority: candidate.priority,
		objectiveScore: candidate.objectiveScore,
		rank: candidate.rank,
		rationale: candidate.rationale,
	}));
}

function rationaleFor({
	credit,
	ledgerView,
	freeUnits,
	paidUnits,
	switchingCost,
	freeButNotDepletable,
}: {
	readonly credit: CreditSummary;
	readonly ledgerView: CreditLedgerView;
	readonly freeUnits: number;
	readonly paidUnits: number;
	readonly switchingCost: number;
	readonly freeButNotDepletable: boolean;
}): string {
	const parts = [
		"objective=maximize-credits",
		`ledgerSeq=${ledgerView.seq}`,
		`credit-facts=${credit.status}`,
		`freeUnits=${roundQuantity(freeUnits)}`,
		`paidUnits=${roundQuantity(paidUnits)}`,
		`switchingCost=${switchingCost}`,
	];
	if (freeButNotDepletable) {
		parts.push("free-tier-not-depletable");
	}
	if (
		credit.budgetHeadroom < LARGE_SCORE &&
		paidUnits > 0 &&
		paidUnits * credit.listUnitCost + switchingCost > credit.budgetHeadroom
	) {
		parts.push("budget-cap-exceeded");
	}
	return parts.join("; ");
}

function findLedgerAccount(
	ledgerView: CreditLedgerView,
	providerId: string,
	dimension: string,
): CreditAccount | null {
	return (
		(ledgerView.accounts ?? []).find(
			(account) =>
				account?.providerId === providerId && account?.dimension === dimension,
		) ?? null
	);
}

function parseDispatchProvider(
	provider: DispatchProviderInput | JsonValue,
): ParsedCandidate {
	const source = requireJsonObject(cloneAsJson(provider), "provider");
	const category = requireCategory(source.category);
	const id = requireString(source.id ?? source.providerId, "provider.id");
	const providerId = requireString(
		source.providerId ?? id,
		"provider.providerId",
	);
	return {
		id,
		providerId,
		definitionId: id,
		category,
		registered: source.registered !== false,
		dimension: requireString(
			source.dimension ?? CATEGORY_DIMENSIONS[category],
			"provider.dimension",
		),
		listUnitCost: nonNegativeNumber(
			source.listUnitCost,
			"provider.listUnitCost",
			0,
		),
		switchingCost: nonNegativeNumber(
			source.switchingCost ?? 0,
			"provider.switchingCost",
			0,
		),
		source,
	};
}

function parsePlacementCandidate(
	candidate: PlacementCandidateInput | JsonValue,
): ParsedCandidate {
	const source = requireJsonObject(cloneAsJson(candidate), "candidate");
	const definitionId = requireString(
		source.definitionId ?? source.id,
		"candidate.definitionId",
	);
	const providerId = requireString(
		source.providerId ?? definitionId,
		"candidate.providerId",
	);
	return {
		definitionId,
		providerId,
		category: "placement",
		registered: source.registered !== false,
		resourceType: requireString(source.resourceType, "candidate.resourceType"),
		dimension: requireString(source.dimension, "candidate.dimension"),
		listUnitCost: nonNegativeNumber(
			source.listUnitCost,
			"candidate.listUnitCost",
			0,
		),
		specificity: isJsonNumber(source.specificity) ? source.specificity : 0,
		priority:
			isJsonNumber(source.priority) && Number.isInteger(source.priority)
				? source.priority
				: 0,
		region:
			isJsonString(source.region) && source.region.length > 0
				? source.region
				: undefined,
		switchingCost: nonNegativeNumber(
			source.switchingCost ?? 0,
			"candidate.switchingCost",
			0,
		),
		source,
	};
}

function parseRegistry(
	registry: DispatcherRegistry | (DispatchProviderInput | JsonValue)[],
): DispatcherRegistry {
	if (Array.isArray(registry)) {
		return createDispatcherRegistry(registry);
	}
	if (
		!isJsonObject(registry) ||
		!(registry.byCategory instanceof Map) ||
		!Array.isArray(registry.records)
	) {
		throw new TypeError("request.registry must be a Dispatcher registry");
	}
	return registry;
}

export function parseCreditLedgerView(
	ledgerInput: CreditLedgerView | JsonValue,
): CreditLedgerView {
	const ledgerView = cloneAsJson(ledgerInput);
	if (!isJsonObject(ledgerView)) {
		throw new TypeError("ledgerView must be a CreditLedgerView snapshot");
	}
	if (ledgerView.view !== "CreditLedgerView") {
		throw new TypeError("ledgerView.view must be CreditLedgerView");
	}
	const seq = requireNonNegativeInteger(ledgerView.seq, "ledgerView.seq");
	if (!Array.isArray(ledgerView.accounts)) {
		throw new TypeError("ledgerView.accounts must be an array");
	}
	const accounts = ledgerView.accounts.map(parseCreditAccount);
	const reservations = requireArray(
		ledgerView.reservations,
		"ledgerView.reservations",
	).map(parseDispatchReservation);
	const digest = optionalString(ledgerView.digest, "ledgerView.digest");
	const balanceHash = optionalString(
		ledgerView.balanceHash,
		"ledgerView.balanceHash",
	);
	const asOf =
		ledgerView.asOf === undefined
			? undefined
			: requireInstant(ledgerView.asOf, "ledgerView.asOf");
	const accountKeys = new Set<string>();
	for (const account of accounts) {
		const key = canonicalJson([account.providerId, account.dimension]);
		if (accountKeys.has(key)) throw new TypeError("duplicate ledger account");
		accountKeys.add(key);
		const grantIds = new Set<string>();
		for (const grant of account.credits ?? []) {
			if (grantIds.has(grant.creditId)) {
				throw new TypeError("duplicate credit grant id");
			}
			grantIds.add(grant.creditId);
		}
	}
	const reservationIds = new Set<string>();
	for (const reservation of reservations) {
		if (reservationIds.has(reservation.reservationId)) {
			throw new TypeError("duplicate reservation id");
		}
		reservationIds.add(reservation.reservationId);
	}
	const parsed: CreditLedgerView = {
		view: "CreditLedgerView",
		seq,
		accounts,
		...(digest === undefined ? undefined : { digest }),
		...(balanceHash === undefined ? undefined : { balanceHash }),
		...(asOf === undefined ? undefined : { asOf }),
		...(ledgerView.reservations === undefined ? undefined : { reservations }),
	};
	for (const account of parsed.accounts) {
		const holds = (parsed.reservations ?? []).filter(
			(reservation) =>
				reservation.providerId === account.providerId &&
				reservation.dimension === account.dimension &&
				(reservation.status === "pending" || reservation.status === "running"),
		);
		if (
			account.budgetCap !== undefined &&
			holds.some((hold) => hold.reservedCost === undefined)
		)
			throw new TypeError(
				"hard budget requires priced outstanding reservations",
			);
		const heldCost = holds.reduce(
			(total, hold) => total + (hold.reservedCost ?? 0),
			0,
		);
		if (holds.length > 0 && roundCost(heldCost) > (account.reservedCost ?? 0))
			throw new TypeError(
				"account reservedCost omits outstanding reservation exposure",
			);
	}
	return parsed;
}

function parseCreditAccount(value: JsonValue): CreditAccount {
	const account = requireJsonObject(value, "ledgerView.account");
	const currency = optionalString(account.currency, "account.currency");
	const credits = requireArray(account.credits, "account.credits").map(
		parseCreditGrant,
	);
	return {
		providerId: requireString(account.providerId, "account.providerId"),
		dimension: requireString(account.dimension, "account.dimension"),
		...(currency === undefined ? undefined : { currency }),
		...optionalNumberProperty("listUnitCost", account.listUnitCost),
		...optionalNumberProperty("freeHeadroom", account.freeHeadroom),
		...optionalNumberProperty("rateHeadroom", account.rateHeadroom),
		...optionalNumberProperty(
			"concurrencyHeadroom",
			account.concurrencyHeadroom,
		),
		...optionalNumberProperty("budgetCap", account.budgetCap),
		...optionalNumberProperty("spendToDate", account.spendToDate),
		...optionalNumberProperty("reservedUnits", account.reservedUnits),
		...optionalNumberProperty("reservedCost", account.reservedCost),
		...(account.credits === undefined ? undefined : { credits }),
	};
}

function parseCreditGrant(value: JsonValue): CreditGrant {
	const grant = requireJsonObject(value, "account.credit");
	const expiresAt =
		grant.expiresAt === undefined
			? undefined
			: requireInstant(grant.expiresAt, "credit.expiresAt");
	const windowEnd =
		grant.windowEnd === undefined
			? undefined
			: requireInstant(grant.windowEnd, "credit.windowEnd");
	return {
		creditId: requireString(grant.creditId, "credit.creditId"),
		freeHeadroom: numericFact(grant.freeHeadroom),
		...(expiresAt === undefined ? undefined : { expiresAt }),
		...(windowEnd === undefined ? undefined : { windowEnd }),
	};
}

function parseDispatchReservation(value: JsonValue): DispatchReservation {
	const reservation = requireJsonObject(value, "ledgerView.reservation");
	const expiresAt = optionalInstant(
		reservation.expiresAt,
		"reservation.expiresAt",
	);
	const consumption =
		reservation.consumption === undefined
			? undefined
			: parseReservedConsumption(reservation.consumption);
	return {
		reservationId: requireString(
			reservation.reservationId,
			"reservation.reservationId",
		),
		providerId: requireString(reservation.providerId, "reservation.providerId"),
		dimension: requireString(reservation.dimension, "reservation.dimension"),
		units: requirePositiveNumber(reservation.units, "reservation.units"),
		expectedSeq: requireNonNegativeInteger(
			reservation.expectedSeq,
			"reservation.expectedSeq",
		),
		committedSeq: requireNonNegativeInteger(
			reservation.committedSeq,
			"reservation.committedSeq",
		),
		status: requireReservationStatus(reservation.status),
		...(reservation.expiresAt === undefined ? undefined : { expiresAt }),
		...optionalNumberProperty("confirmedSeq", reservation.confirmedSeq),
		...optionalNumberProperty("releasedSeq", reservation.releasedSeq),
		...optionalStringProperty("releaseReason", reservation.releaseReason),
		...optionalNumberProperty("providerUsageSeq", reservation.providerUsageSeq),
		...optionalNumberProperty("startedSeq", reservation.startedSeq),
		...(consumption === undefined ? undefined : { consumption }),
		...optionalNumberProperty("reservedCost", reservation.reservedCost),
		...optionalNumberProperty("actualCost", reservation.actualCost),
		...optionalStringProperty("commandHash", reservation.commandHash),
		...optionalNumberProperty("unitCost", reservation.unitCost),
		...optionalNumberProperty("switchingCost", reservation.switchingCost),
		...optionalStringProperty(
			"dispatchRequestHash",
			reservation.dispatchRequestHash,
		),
		...optionalStringProperty(
			"decisionInputJson",
			reservation.decisionInputJson,
		),
		...optionalNumberProperty("estimatedCost", reservation.estimatedCost),
		...optionalStringProperty("usageEvidenceRef", reservation.usageEvidenceRef),
	};
}

function parseReservedConsumption(value: JsonValue): ReservedConsumption {
	const consumption = requireJsonObject(value, "reservation.consumption");
	const credits = requireArray(
		consumption.credits,
		"reservation.consumption.credits",
	).map((entry) => {
		const credit = requireJsonObject(entry, "reservation.consumption.credit");
		return {
			creditId: requireString(
				credit.creditId,
				"reservation.consumption.creditId",
			),
			units: requirePositiveNumber(
				credit.units,
				"reservation.consumption.units",
			),
		};
	});
	return {
		freeHeadroom: nonNegativeNumber(
			consumption.freeHeadroom,
			"reservation.consumption.freeHeadroom",
			0,
		),
		credits,
		...optionalNumberProperty("rateUnits", consumption.rateUnits),
		...optionalNumberProperty("concurrencySlots", consumption.concurrencySlots),
	};
}

function numericFact(value: JsonValue | undefined): number {
	return isJsonNumber(value) ? value : Number.NaN;
}

function optionalNumberProperty(
	key: string,
	value: JsonValue | undefined,
): Readonly<Record<string, number>> | undefined {
	return value === undefined ? undefined : { [key]: numericFact(value) };
}

function optionalStringProperty(
	key: string,
	value: JsonValue | undefined,
): Readonly<Record<string, string>> | undefined {
	return value === undefined ? undefined : { [key]: requireString(value, key) };
}

function optionalString(
	value: JsonValue | undefined,
	fieldName: string,
): string | undefined {
	return value === undefined ? undefined : requireString(value, fieldName);
}

function requireReservationStatus(
	value: JsonValue | undefined,
): DispatchReservation["status"] {
	if (
		value === "pending" ||
		value === "running" ||
		value === "confirmed" ||
		value === "released" ||
		value === "expired"
	) {
		return value;
	}
	throw new TypeError("invalid reservation status");
}

function parseHysteresis(
	hysteresis: HysteresisInput | JsonValue | undefined,
): HysteresisInput | null {
	if (hysteresis === undefined || hysteresis === null) return null;
	const value = requireJsonObject(
		cloneAsJson(hysteresis),
		"request.hysteresis",
	);
	const dwellWindow = requireString(
		value.dwellWindow,
		"request.hysteresis.dwellWindow",
	);
	dwellDurationMs(dwellWindow);
	const observedAt = requireInstant(
		value.observedAt,
		"request.hysteresis.observedAt",
	);
	const savingsSince =
		value.savingsSince === undefined
			? undefined
			: requireInstant(value.savingsSince, "request.hysteresis.savingsSince");
	if (savingsSince && Date.parse(savingsSince) > Date.parse(observedAt))
		throw new TypeError("savingsSince must not follow observedAt");
	const parsed: HysteresisInput = {
		incumbentProviderId: requireString(
			value.incumbentProviderId,
			"request.hysteresis.incumbentProviderId",
		),
		minimumSavings: nonNegativeNumber(
			value.minimumSavings ?? 0,
			"request.hysteresis.minimumSavings",
			0,
		),
		dwellWindow,
		observedAt,
	};
	if (savingsSince) parsed.savingsSince = savingsSince;
	if (value.challengerProviderId !== undefined)
		parsed.challengerProviderId = requireString(
			value.challengerProviderId,
			"request.hysteresis.challengerProviderId",
		);
	return parsed;
}

function dwellDurationMs(value: string): number {
	const match =
		/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
			requireString(value, "request.hysteresis.dwellWindow"),
		);
	if (!match?.slice(1).some((part) => part !== undefined))
		throw new TypeError("dwellWindow must be an ISO-8601 duration");
	const duration =
		((Number(match[1] ?? 0) * 24 + Number(match[2] ?? 0)) * 3600 +
			Number(match[3] ?? 0) * 60 +
			Number(match[4] ?? 0)) *
		1000;
	if (!Number.isFinite(duration))
		throw new TypeError("dwellWindow must be a finite duration");
	return duration;
}

function findReservation(ledgerView: CreditLedgerView, reservationId: string) {
	return (
		(ledgerView.reservations ?? []).find(
			(reservation) => reservation?.reservationId === reservationId,
		) ?? null
	);
}

function reservationFact(
	type: string,
	reservation: DispatchReservation,
	overrides: {
		ledgerSeq?: number;
		reason?: string;
		providerUsageSeq?: number;
	} = {},
): DispatchFact {
	return {
		type,
		data: {
			...clone(reservation),
			ledgerSeq: overrides.ledgerSeq,
			reason: overrides.reason,
			providerUsageSeq: overrides.providerUsageSeq,
		},
	};
}

function consumeReservedFreeHeadroom(
	account: CreditAccount,
	units: number,
	asOf?: string,
) {
	let remaining = units;
	const consumption: ReservedConsumption = {
		freeHeadroom: 0,
		credits: [],
	};
	if (optionalNonNegativeNumber(account.freeHeadroom)) {
		consumption.freeHeadroom = units;
		account.freeHeadroom = roundQuantity(account.freeHeadroom - units);
	}
	if (!Array.isArray(account.credits) || remaining <= 0) return consumption;
	const ordered = [...account.credits]
		.filter((credit) => grantIsLive(credit, asOf))
		.sort(
			(left, right) =>
				Date.parse(grantExpiry(left) ?? "9999-12-31") -
					Date.parse(grantExpiry(right) ?? "9999-12-31") ||
				left.creditId.localeCompare(right.creditId),
		);
	for (const credit of ordered) {
		if (!optionalNonNegativeNumber(credit?.freeHeadroom)) continue;
		const consumed = Math.min(credit.freeHeadroom, remaining);
		credit.freeHeadroom = roundQuantity(credit.freeHeadroom - consumed);
		if (consumed > 0) {
			consumption.credits.push({
				creditId: credit.creditId,
				units: roundQuantity(consumed),
			});
		}
		remaining = roundQuantity(remaining - consumed);
		if (remaining <= 0) return consumption;
	}
	return consumption;
}

function restoreReservedFreeHeadroom(
	account: CreditAccount,
	consumption: ReservedConsumption | undefined,
) {
	if (!consumption || !isJsonObject(consumption)) return;
	if (optionalNonNegativeNumber(account.freeHeadroom)) {
		account.freeHeadroom = roundQuantity(
			account.freeHeadroom + (consumption.freeHeadroom ?? 0),
		);
	}
	if (!Array.isArray(account.credits) || !Array.isArray(consumption.credits))
		return;
	for (const restoredCredit of consumption.credits) {
		const credit = account.credits.find(
			(candidate) => candidate?.creditId === restoredCredit.creditId,
		);
		if (credit && optionalNonNegativeNumber(credit.freeHeadroom)) {
			credit.freeHeadroom = roundQuantity(
				credit.freeHeadroom + restoredCredit.units,
			);
		}
	}
}

function failedDecision({
	objective,
	reason,
	rejectedCandidates = [],
}: {
	readonly objective: DispatchObjective;
	readonly reason: string;
	readonly rejectedCandidates?: readonly {
		readonly definitionId: string;
		readonly reason: string;
	}[];
}) {
	return {
		ok: false as const,
		schema: CREDIT_DISPATCH_SCHEMA,
		objective,
		reason,
		ranking: [],
		rejectedCandidates,
	};
}

function ledgerBalanceHash(ledgerView: CreditLedgerView): string {
	return parseHashRef(
		ledgerView.balanceHash ?? ledgerView.digest ?? stableHash(ledgerView),
	);
}

function parseHashRef(value: string): string {
	if (isJsonString(value) && SHA256_REF.test(value)) return value;
	if (isJsonString(value) && /^[a-f0-9]{64}$/.test(value))
		return `sha256:${value}`;
	return stableHash(value);
}

export function stableHash<T>(value: T): string {
	return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson<T>(value: T): string {
	return JSON.stringify(sortKeys(cloneAsJson(value))) ?? "null";
}

function sortKeys(value: JsonValue): JsonValue {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (!isJsonObject(value)) return value;
	const sorted: JsonBag = {};
	for (const key of Object.keys(value).sort()) {
		const entry = value[key];
		if (entry !== undefined) sorted[key] = sortKeys(entry);
	}
	return sorted;
}

function requireCategory(category: JsonValue | undefined): DispatchCategory {
	if (
		category === "runner" ||
		category === "build-machine" ||
		category === "traffic-backend"
	) {
		return category;
	}
	throw new TypeError(
		"category must be runner, build-machine, or traffic-backend",
	);
}

function requireObjective(objective: JsonValue | undefined): DispatchObjective {
	if (objective === "maximize-credits") return objective;
	throw new TypeError("objective must be maximize-credits");
}

function requireString(
	value: JsonValue | undefined,
	fieldName: string,
): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${fieldName} must be a non-empty string`);
	}
	return value;
}

function optionalInstant(
	value: JsonValue | undefined,
	fieldName: string,
): string | null {
	if (value === undefined || value === null) return null;
	return requireInstant(value, fieldName);
}

function requireInstant(
	value: JsonValue | undefined,
	fieldName: string,
): string {
	const timestamp = requireString(value, fieldName);
	const parsed = Date.parse(timestamp);
	if (Number.isNaN(parsed)) {
		throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
	}
	return new Date(parsed).toISOString();
}

function requirePositiveNumber(
	value: JsonValue | undefined,
	fieldName: string,
): number {
	if (!isJsonNumber(value) || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(`${fieldName} must be greater than 0`);
	}
	return value;
}

function requirePositiveInteger(
	value: JsonValue | undefined,
	fieldName: string,
): number {
	if (!isJsonNumber(value) || !Number.isInteger(value) || value <= 0) {
		throw new TypeError(`${fieldName} must be a positive integer`);
	}
	return value;
}

function requireNonNegativeInteger(
	value: JsonValue | undefined,
	fieldName: string,
): number {
	if (!isJsonNumber(value) || !Number.isInteger(value) || value < 0) {
		throw new TypeError(`${fieldName} must be a non-negative integer`);
	}
	return value;
}

function nonNegativeNumber(
	value: JsonValue | undefined,
	fieldName: string,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!optionalNonNegativeNumber(value)) {
		throw new TypeError(`${fieldName} must be a non-negative number`);
	}
	return value;
}

function optionalNonNegativeNumber(
	value: JsonValue | undefined,
): value is number {
	return isJsonNumber(value) && Number.isFinite(value) && value >= 0;
}

function requireArray(
	value: JsonValue | undefined,
	fieldName: string,
): readonly JsonValue[] {
	if (value === undefined) return [];
	if (!Array.isArray(value))
		throw new TypeError(`${fieldName} must be an array`);
	return value;
}

function isReservationLedger(
	value: ReservationLedgerPort | JsonValue | undefined,
): value is ReservationLedgerPort {
	return (
		isJsonObject(value) &&
		value.reserve instanceof Function &&
		value.snapshot instanceof Function
	);
}

function requireJsonObject(
	value: JsonValue | undefined,
	fieldName: string,
): JsonObject {
	if (!isJsonObject(value)) {
		throw new TypeError(`${fieldName} must be an object`);
	}
	return value;
}

function roundCost(value: number): number {
	return Number(value.toFixed(12));
}

function roundQuantity(value: number): number {
	return Number(value.toFixed(9));
}

function clone<T>(value: T): T {
	return structuredClone(value);
}
