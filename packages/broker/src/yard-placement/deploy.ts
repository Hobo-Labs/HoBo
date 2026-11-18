import { randomUUID } from "node:crypto";
import { clone, toJsonString } from "@bufbuild/protobuf";
import { first } from "@hobo/core/total-access";
import { compareDecimal, type Decimal, parseDecimal } from "@hobo/pricing";
import {
	type BudgetAdmissionAuthority,
	type BudgetIdentity,
	BudgetIdentitySchema,
	type BudgetReservation,
	budgetIdentityKey,
	type HostingPolicyProof,
	HostingPolicyProofSchema,
	type HostingQuote,
	HostingQuoteSchema,
	hostingQuoteDigest,
	validateHostingQuote,
} from "../budget-authority.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "../json.js";
import type { GateDecision } from "../planes.js";
import type { BrokerCatalog, PlacementDecision } from "../types.js";
import { hasUnverifiedCampConstraints } from "./camp-constraints.js";
import { defaultYardGenerationConnectors } from "./connectors.js";
import {
	createDefaultEventStoreFoldResolvers,
	createEventStoreFoldResolverRegistry,
	type ProviderNativeSignal,
	type YardEventStoreFoldResolver,
} from "./event-store-resolvers.js";
import { YARD_EVENTS, type YardEvent, yardEvent } from "./events.js";
import {
	emptyYardEventStoreState,
	foldYardEventStore,
	inventorySnapshotFromFold,
	type YardEventStoreState,
} from "./folds.js";
import {
	createYardGenerationSaga,
	DEFAULT_YARD_GENERATION_POLICY,
	planYardGeneration,
	type YardGenerationConnector,
} from "./generation.js";
import { createYardRuntimeCatalog, localYardInstance } from "./inventory.js";
import { matchYard } from "./matching.js";
import { parseYardResidencyTag } from "./residency.js";
import {
	buildExecutionUnits,
	composeResolverPins,
	defaultProviderResolvers,
	EMPTY_RESOLVER_CONFIG,
} from "./resolvers.js";
import {
	BINDLE_DEPLOYMENT_REQUEST_SCHEMA,
	type BindleDeploymentRequest,
	type ContentHash,
	contentHashOf,
	emptyYardLayout,
	type LocalHostingProof,
	parseCampLayout,
	parseYardLayout,
	YARD_PLACEMENT_RECEIPT_SCHEMA,
	type YardGenerationPolicy,
	type YardPlacementReceipt,
	type YardPlacementRequest,
} from "./types.js";

export interface LocalHostingAuthorizationContext {
	readonly brokerId: string;
	readonly request: BindleDeploymentRequest;
	readonly requestDigest: ContentHash;
	readonly catalogHash: string;
	readonly yardId: string;
	readonly providerId: string;
	readonly ownerTenantId: string;
	readonly placements: readonly Readonly<PlacementDecision>[];
	readonly bindingDigest: ContentHash;
}

/** Inputs a host uses to quote the exact resource work a Yard will execute. */
export interface YardHostingWorkInput {
	readonly request: BindleDeploymentRequest;
	readonly brokerId: string;
	readonly ownerTenantId: string;
	readonly catalog: BrokerCatalog;
	readonly yardId: string;
	readonly providerId: string;
	readonly generationPlanHash?: ContentHash | undefined;
}

function hostingWorkDigest(input: {
	readonly requestDigest: ContentHash;
	readonly brokerId: string;
	readonly ownerTenantId: string;
	readonly catalogHash: string;
	readonly yardId: string;
	readonly providerId: string;
	readonly placements: readonly Readonly<PlacementDecision>[];
	readonly generationPlanHash: ContentHash | undefined;
}): ContentHash {
	return contentHashOf({
		schemaVersion: "hobo.yard-hosting-work/v1",
		...input,
		generationPlanHash: input.generationPlanHash ?? "",
	});
}

/** Plan quoteable Yard work using the same selection and binding as admission. */
export function prepareYardHostingWork(input: YardHostingWorkInput):
	| {
			readonly workDigest: ContentHash;
			readonly placements: readonly Readonly<PlacementDecision>[];
	  }
	| { readonly error: string; readonly code: string } {
	const request = parseBindleDeploymentRequest(cloneAsJson(input.request));
	if (hasUnverifiedCampConstraints(request))
		return {
			code: "camp-constraints-unverified",
			error: "Camp requirements cannot yet be verified for this work",
		};
	if (request.ownerTenantId && request.ownerTenantId !== input.ownerTenantId)
		return {
			code: "owner-tenant-mismatch",
			error: "work owner differs from request owner",
		};
	if (
		request.yard.selectionMode === "exact" &&
		request.yard.requestedYardId !== input.yardId
	)
		return {
			code: "yard-exact-id-mismatch",
			error: "quote Yard does not match the exact requested Yard",
		};
	if (selectOrGenerateCamp(request, input.yardId) === undefined)
		return {
			code: "camp-yard-mismatch",
			error: "requested Camp is not a direct child of the selected Yard",
		};
	const catalogHash = input.catalog.catalogHash;
	const selected = placeResourcesUnderYard(
		request,
		input.providerId,
		input.catalog,
	);
	if ("error" in selected) return selected;
	if (input.catalog.catalogHash !== catalogHash)
		return {
			code: "catalog-definition-invalid",
			error: "catalog changed while planning quote work",
		};
	const placements = Object.freeze(
		selected.decisions.map((placement) => Object.freeze({ ...placement })),
	);
	const workDigest = hostingWorkDigest({
		requestDigest: contentHashOf(request),
		brokerId: input.brokerId,
		ownerTenantId: input.ownerTenantId,
		catalogHash,
		yardId: input.yardId,
		providerId: input.providerId,
		placements,
		generationPlanHash: input.generationPlanHash,
	});
	return { workDigest, placements };
}

export interface YardFirstPlacementDeps {
	readonly brokerId: string;
	readonly catalog: BrokerCatalog;
	readonly ownerTenantId?: string;
	readonly runtimeCatalog?: ReturnType<typeof createYardRuntimeCatalog>;
	readonly generationPolicy?: YardGenerationPolicy;
	readonly connectors?: ReadonlyMap<string, YardGenerationConnector>;
	/** Seed a ready local yard when inventory is empty (zero-config path). */
	readonly seedLocalYard?: boolean;
	/** Provider event-store fold resolvers (default: local+azure+aws+gcp). */
	readonly foldResolvers?: readonly YardEventStoreFoldResolver[];
	/** Prior event log for crash-resume / replay. */
	readonly priorEvents?: readonly YardEvent[];
	/** Host-bound Gatekeeper/policy authorization. Approvals and unfulfilled
	 * obligations cannot be turned into execution merely by affordable pricing. */
	readonly authorizeHosting?: (input: {
		request: BindleDeploymentRequest;
		requestDigest: string;
		quote: HostingQuote;
		quoteDigest: string;
		workDigest: ContentHash;
		placements: readonly Readonly<PlacementDecision>[];
		generationPlanHash: ContentHash | undefined;
		identity: BudgetIdentity;
		now: string;
	}) =>
		| { gate: GateDecision; proof: HostingPolicyProof }
		| Promise<{ gate: GateDecision; proof: HostingPolicyProof }>;
	/** Host policy approval and an enforceable zero-liability assertion for
	 * this exact local work. No local generation is authorized by this hook. */
	readonly authorizeLocalHosting?: (
		input: LocalHostingAuthorizationContext,
	) => LocalHostingProof | undefined | Promise<LocalHostingProof | undefined>;
	/** Trusted whole-request quotes and the shared durable financial authority.
	 * Estimates without an enforceable exposure bound cannot authorize hosting. */
	readonly hostingBudget?: {
		readonly authority: BudgetAdmissionAuthority;
		readonly quotes: readonly HostingQuote[];
		readonly now: () => string;
	};
}

export interface YardFirstPlacementResult {
	readonly outcome: "resolved" | "rejected";
	readonly receipt?: YardPlacementReceipt;
	readonly placements: readonly PlacementDecision[];
	readonly reasons?: readonly {
		readonly plane: string;
		readonly code: string;
		readonly message: string;
	}[];
	readonly generationAttemptId?: string;
	/** Durable yard.* facts emitted for this request (append-only). */
	readonly events: readonly YardEvent[];
	/** Fold projection after applying prior + new events. */
	readonly foldState: YardEventStoreState;
}

/**
 * Canonical production path: Yard match → optional generation → Camp →
 * resolvers → residual resource placement under selected Yard provider only.
 *
 * All decisions append yard.* facts; inventory/generation state is the pure
 * fold of those facts (via the provider event-store fold resolver).
 */
export async function resolveBindleDeployment(
	request: BindleDeploymentRequest,
	deps: YardFirstPlacementDeps,
): Promise<YardFirstPlacementResult> {
	const emitted: YardEvent[] = [];
	let foldState = emptyYardEventStoreState(deps.brokerId);
	// Replay prior events for crash-resume.
	for (const prior of deps.priorEvents ?? []) {
		foldState = foldYardEventStore(foldState, prior);
	}

	const foldRegistry = createEventStoreFoldResolverRegistry(
		deps.foldResolvers ?? createDefaultEventStoreFoldResolvers(),
	);

	const append = (event: YardEvent): void => {
		emitted.push(event);
		foldState = foldYardEventStore(foldState, {
			...event,
			seq: (event.seq ?? foldState.seq) + 1,
		});
	};

	const appendProviderSignals = (
		providerId: string,
		signals: readonly { kind: string; payload: JsonObject }[],
		expected: {
			readonly attemptId: string;
			readonly idempotencyKey: string;
			readonly yardId: string;
			readonly runtimeId: string;
			readonly ownerTenantId: string;
		},
	): void => {
		const resolver =
			foldRegistry.get(providerId) ??
			foldRegistry.get("local") ??
			first(
				createDefaultEventStoreFoldResolvers(),
				"createDefaultEventStoreFoldResolvers()",
			);
		const pending: YardEvent[] = [];
		const allowed = new Set<string>([
			YARD_EVENTS.GenerationStarted,
			YARD_EVENTS.GenerationProgressed,
			YARD_EVENTS.GenerationProvisioned,
			YARD_EVENTS.GenerationFailed,
			YARD_EVENTS.GenerationCompensationRequested,
			YARD_EVENTS.GenerationCompensated,
			YARD_EVENTS.Registered,
			YARD_EVENTS.AttestationStarted,
			YARD_EVENTS.Attested,
			YARD_EVENTS.Ready,
			YARD_EVENTS.StatusChanged,
			YARD_EVENTS.CapacityUpdated,
			YARD_EVENTS.ProviderSignalNormalized,
		]);
		for (const signal of signals) {
			if (
				!isJsonObject(signal.payload) ||
				signal.payload.attemptId !== expected.attemptId ||
				(signal.payload.idempotencyKey !== undefined &&
					signal.payload.idempotencyKey !== expected.idempotencyKey) ||
				(signal.payload.yardId !== undefined &&
					signal.payload.yardId !== expected.yardId) ||
				(signal.payload.runtimeId !== undefined &&
					signal.payload.runtimeId !== expected.runtimeId) ||
				(signal.payload.ownerTenantId !== undefined &&
					signal.payload.ownerTenantId !== expected.ownerTenantId)
			)
				throw new Error("provider signal does not match the generation plan");
			const native: ProviderNativeSignal = {
				providerId,
				kind: signal.kind,
				// SAFETY: assertion required at this I/O or test boundary.
				payload: signal.payload as ProviderNativeSignal["payload"],
			};
			for (const event of resolver.normalize(native)) {
				const type = event.type;
				if (!allowed.has(type))
					throw new Error("provider signal contains a broker-owned event");
				const data = cloneAsJson(event.data);
				if (!isJsonObject(data))
					throw new Error("normalized provider signal data must be an object");
				for (const [key, value] of [
					["attemptId", expected.attemptId],
					["idempotencyKey", expected.idempotencyKey],
					["yardId", expected.yardId],
					["expectedYardId", expected.yardId],
					["providerId", providerId],
					["runtimeId", expected.runtimeId],
				] as const) {
					if (
						data[key] !== undefined &&
						data[key] !== "" &&
						data[key] !== value
					)
						throw new Error(`normalized provider signal has mismatched ${key}`);
				}
				if (
					(type === YARD_EVENTS.Ready ||
						type === YARD_EVENTS.Attested ||
						type === YARD_EVENTS.AttestationStarted) &&
					data.yardId !== expected.yardId
				)
					throw new Error("normalized provider signal lacks the planned Yard");
				if (type === YARD_EVENTS.Ready && data.attemptId !== expected.attemptId)
					throw new Error("ready signal lacks the planned generation attempt");
				if (type === YARD_EVENTS.StatusChanged && data.status === "ready")
					throw new Error(
						"ready status requires an attempt-bound ready signal",
					);
				if (type === YARD_EVENTS.Registered) {
					const yard = data.yard;
					if (
						!isJsonObject(yard) ||
						yard.yardId !== expected.yardId ||
						yard.ownerTenantId !== expected.ownerTenantId ||
						yard.providerId !== providerId ||
						yard.runtimeId !== expected.runtimeId ||
						yard.status === "ready"
					)
						throw new Error(
							"normalized provider registration does not match the generation plan",
						);
				}
				// The broker owns stream sequencing; keep a private normalized snapshot.
				pending.push(
					Object.freeze({
						type,
						data: Object.freeze(data),
						...(event.occurredAt !== undefined
							? { occurredAt: event.occurredAt }
							: undefined),
					}),
				);
			}
		}
		for (const event of pending) append(event);
	};

	if (request.schemaVersion !== BINDLE_DEPLOYMENT_REQUEST_SCHEMA) {
		return rejectResult(
			foldState,
			emitted,
			"contracts",
			"schema-mismatch",
			"invalid deployment request schema",
		);
	}

	// Callers may retain and mutate their input while host callbacks run. Work
	// from a validated private snapshot, including unique resource identities.
	try {
		request = parseBindleDeploymentRequest(cloneAsJson(request));
	} catch (error) {
		return rejectResult(
			foldState,
			emitted,
			"contracts",
			"invalid-deployment-request",
			error instanceof Error ? error.message : "invalid deployment request",
		);
	}
	if (hasUnverifiedCampConstraints(request))
		return rejectResult(
			foldState,
			emitted,
			"placement",
			"camp-constraints-unverified",
			"Camp requirements cannot yet be verified for this work",
		);

	const ownerTenantId = request.ownerTenantId || deps.ownerTenantId || "local";
	if (deps.ownerTenantId && deps.ownerTenantId !== ownerTenantId)
		return rejectResult(
			foldState,
			emitted,
			"policy",
			"owner-tenant-mismatch",
			"deployment owner differs from the authenticated tenant",
		);
	const runtimeCatalogInput = deps.runtimeCatalog;
	const generationPolicyInput = deps.generationPolicy;
	const connectorsInput = deps.connectors;
	const runtimeCatalog = runtimeCatalogInput ?? createYardRuntimeCatalog();
	const requestDigest = contentHashOf(request);
	const brokerId = deps.brokerId;
	const ownerTenant = deps.ownerTenantId;
	const catalog = deps.catalog;
	const hostingBudget = deps.hostingBudget;
	const localAuthority = deps.authorizeLocalHosting;
	const paidAuthority = deps.authorizeHosting;
	const budgetAuthority = hostingBudget?.authority;
	const budgetPersistence = budgetAuthority?.persistence;
	const budgetRead = budgetAuthority?.read;
	const budgetLookup = budgetAuthority?.lookup;
	const budgetReserve = budgetAuthority?.reserve;
	const budgetClaim = budgetAuthority?.claimExecution;
	const budgetUncertain = budgetAuthority?.uncertain;
	const budgetClock = hostingBudget?.now;
	const catalogHash = deps.catalog.catalogHash;
	const quoteKey = (quotes: readonly HostingQuote[]) =>
		contentHashOf(
			quotes.map((quote) => toJsonString(HostingQuoteSchema, quote)),
		);
	let quotes: HostingQuote[] = [];
	let quotesDigest: ContentHash | undefined;
	try {
		if (hostingBudget) {
			quotes = hostingBudget.quotes.map((quote) =>
				clone(HostingQuoteSchema, quote),
			);
			quotesDigest = quoteKey(quotes);
			if (quoteKey(hostingBudget.quotes) !== quotesDigest)
				throw new Error("hosting quote evidence changed during snapshot");
		}
	} catch {
		return rejectResult(
			foldState,
			emitted,
			"billing",
			"hosting-quote-invalid",
			"hosting quote evidence could not be snapshotted",
		);
	}
	const paidContextCurrent = () => {
		try {
			return (
				deps.hostingBudget === hostingBudget &&
				deps.authorizeHosting === paidAuthority &&
				deps.brokerId === brokerId &&
				deps.ownerTenantId === ownerTenant &&
				deps.catalog === catalog &&
				deps.catalog.catalogHash === catalogHash &&
				contentHashOf(request) === requestDigest &&
				(!hostingBudget ||
					(hostingBudget.authority === budgetAuthority &&
						budgetAuthority?.persistence === budgetPersistence &&
						budgetAuthority?.read === budgetRead &&
						budgetAuthority?.lookup === budgetLookup &&
						budgetAuthority?.reserve === budgetReserve &&
						budgetAuthority?.claimExecution === budgetClaim &&
						budgetAuthority?.uncertain === budgetUncertain &&
						hostingBudget.now === budgetClock &&
						quoteKey(hostingBudget.quotes) === quotesDigest))
			);
		} catch {
			return false;
		}
	};
	const localContextCurrent = () => {
		try {
			return (
				deps.authorizeLocalHosting === localAuthority &&
				deps.hostingBudget === hostingBudget &&
				deps.brokerId === brokerId &&
				deps.ownerTenantId === ownerTenant &&
				deps.catalog === catalog &&
				deps.catalog.catalogHash === catalogHash &&
				contentHashOf(request) === requestDigest
			);
		} catch {
			return false;
		}
	};
	const reservationId = `hosting:${deps.brokerId}:${request.requestId}`;
	let budgetReservation: BudgetReservation | undefined;
	let hostingQuote: HostingQuote | undefined;
	let hostingPolicyProof: HostingPolicyProof | undefined;
	let localHostingProof: LocalHostingProof | undefined;
	const markGenerationUncertain = () => {
		if (!budgetReservation) return true;
		try {
			if (!budgetAuthority || !budgetUncertain) return false;
			budgetUncertain.call(budgetAuthority, reservationId);
			return true;
		} catch {
			return false;
		}
	};
	const isLocalProvider = (providerId: string) =>
		providerId === "local" || providerId === "@hobo/provider-local-host";
	function economicCosts(
		yards: readonly {
			yardId: string;
			providerId: string;
			ownerTenantId: string;
		}[],
	): ReadonlyMap<string, number> {
		const costs = new Map<string, number>();
		const context = deps.hostingBudget;
		let ledger: ReturnType<BudgetAdmissionAuthority["read"]> | undefined;
		let previous: ReturnType<BudgetAdmissionAuthority["lookup"]> | undefined;
		try {
			ledger = context?.authority.read(context.now());
			previous = context?.authority.lookup(reservationId);
		} catch {
			throw new Error("hosting budget evidence is unavailable");
		}
		for (const yard of yards) {
			if (
				!context &&
				isLocalProvider(yard.providerId) &&
				request.spendEstimateUsd === 0 &&
				deps.authorizeLocalHosting !== undefined
			) {
				costs.set(yard.yardId, 0);
				continue;
			}
			if (
				context?.authority.persistence !== "durable-cas" ||
				!ledger?.identity ||
				ledger.identity.tenantId !== ownerTenantId
			)
				continue;
			const quote = quotes.find(
				(row) =>
					row.yardId === yard.yardId &&
					row.providerId === yard.providerId &&
					row.ownerTenantId === ownerTenantId &&
					row.requestDigest === requestDigest,
			);
			if (!quote) continue;
			try {
				validateHostingQuote(quote, context.now());
			} catch {
				continue;
			}
			if (quote.liabilityBoundMicros === undefined) continue;
			if (
				previous
					? previous.quoteId !== quote.quoteId || previous.status === "released"
					: ledger.spentMicros +
							ledger.reservedMicros +
							ledger.unresolvedMicros +
							ledger.recoveryReserveMicros +
							ledger.externalCommittedMicros +
							quote.liabilityBoundMicros >
						ledger.limitMicros
			)
				continue;
			costs.set(yard.yardId, quote.totalMicros);
		}
		return costs;
	}
	async function admitHosting(
		yardId: string,
		providerId: string,
		placements?: readonly PlacementDecision[],
		generationPlanHash?: ContentHash,
	): Promise<void> {
		const context = deps.hostingBudget;
		if (context !== hostingBudget)
			throw new Error("hosting budget changed during placement");
		if (generationPlanHash && !context)
			throw new Error(
				"durable shared hosting budget authority required for generation",
			);
		if (
			!context &&
			isLocalProvider(providerId) &&
			request.spendEstimateUsd === 0
		) {
			const authorize = localAuthority;
			if (!authorize || !placements)
				throw new Error(
					"bound local hosting authorization required before placement",
				);
			if (!localContextCurrent())
				throw new Error("local hosting context changed before authorization");
			const work = Object.freeze(
				placements.map((placement) => Object.freeze({ ...placement })),
			);
			const binding = {
				brokerId,
				requestDigest,
				catalogHash,
				yardId,
				providerId,
				ownerTenantId,
				placements: work,
			};
			const bindingDigest = contentHashOf(binding);
			const input = Object.freeze({ ...binding, request, bindingDigest });
			const proof = await authorize(input);
			if (
				!localContextCurrent() ||
				contentHashOf(placements) !== contentHashOf(work)
			)
				throw new Error("local hosting context changed during authorization");
			if (
				proof?.schemaVersion !== "hobo.local-hosting-proof/v1" ||
				proof.bindingDigest !== bindingDigest ||
				(proof.effect !== "allow" && proof.effect !== "allow-degraded") ||
				proof.obligationsSatisfied !== true ||
				!isJsonString(proof.policyHash) ||
				!/^sha256:[0-9a-f]{64}$/u.test(proof.policyHash) ||
				!isJsonString(proof.evidenceRef) ||
				!proof.evidenceRef.trim() ||
				proof.liabilityBoundMicros !== 0
			)
				throw new Error(
					"local hosting lacks bound policy and zero-liability proof",
				);
			localHostingProof = Object.freeze({
				schemaVersion: proof.schemaVersion,
				bindingDigest: proof.bindingDigest,
				effect: proof.effect,
				obligationsSatisfied: true,
				policyHash: proof.policyHash,
				evidenceRef: proof.evidenceRef,
				liabilityBoundMicros: 0,
			});
			return;
		}
		if (context?.authority.persistence !== "durable-cas")
			throw new Error("durable shared hosting budget authority required");
		if (!paidContextCurrent())
			throw new Error("hosting context changed before policy");
		const quote = quotes.find(
			(row) =>
				row.yardId === yardId &&
				row.providerId === providerId &&
				row.ownerTenantId === ownerTenantId &&
				row.requestDigest === requestDigest,
		);
		if (!quote) throw new Error("complete hosting quote missing");
		if (!placements) throw new Error("selected quote work missing");
		const work = Object.freeze(
			placements.map((placement) => Object.freeze({ ...placement })),
		);
		const workDigest = hostingWorkDigest({
			requestDigest,
			brokerId,
			ownerTenantId,
			catalogHash,
			yardId,
			providerId,
			placements: work,
			generationPlanHash,
		});
		if (quote.workDigest !== workDigest)
			throw new Error(
				"hosting quote does not bind selected work and generation plan",
			);
		const ledger = context.authority.read(context.now());
		if (!ledger.identity) throw new Error("budget identity missing");
		const authorize = paidAuthority;
		if (!authorize)
			throw new Error("bound hosting policy authorization required");
		const expectedQuote = toJsonString(HostingQuoteSchema, quote);
		const quoteDigest = hostingQuoteDigest(quote);
		const policyQuote = clone(HostingQuoteSchema, quote);
		const policyIdentity = clone(BudgetIdentitySchema, ledger.identity);
		const expectedIdentity = toJsonString(BudgetIdentitySchema, policyIdentity);
		const { gate, proof } = await authorize({
			request,
			requestDigest,
			quote: policyQuote,
			quoteDigest,
			workDigest,
			placements: work,
			generationPlanHash,
			identity: policyIdentity,
			now: context.now(),
		});
		if (
			!paidContextCurrent() ||
			contentHashOf(placements) !== contentHashOf(work) ||
			toJsonString(HostingQuoteSchema, policyQuote) !== expectedQuote ||
			toJsonString(BudgetIdentitySchema, policyIdentity) !== expectedIdentity
		)
			throw new Error("hosting evidence changed while policy was evaluated");
		if (
			(gate.effect !== "allow" && gate.effect !== "allow-degraded") ||
			proof.effect !== gate.effect ||
			!proof.obligationsSatisfied ||
			!proof.evidenceRef ||
			!proof.policyHash ||
			proof.requestDigest !== requestDigest ||
			proof.quoteId !== quote.quoteId ||
			proof.quoteDigest !== quoteDigest ||
			!proof.identity ||
			budgetIdentityKey(proof.identity) !== budgetIdentityKey(ledger.identity)
		)
			throw new Error(
				"hosting policy denies, requires approval, or lacks bound fulfilled obligations",
			);
		const policyProof = clone(HostingPolicyProofSchema, proof);
		const expectedProof = toJsonString(HostingPolicyProofSchema, policyProof);
		const reservedQuote = clone(HostingQuoteSchema, quote);
		const reservedIdentity = clone(BudgetIdentitySchema, ledger.identity);
		const reserveNow = context.now();
		if (!paidContextCurrent())
			throw new Error("hosting context changed before reservation");
		validateHostingQuote(quote, reserveNow);
		budgetReservation = context.authority.reserve({
			reservationId,
			requestDigest,
			quote: reservedQuote,
			identity: reservedIdentity,
			expectedSeq: ledger.seq,
			now: reserveNow,
		});
		if (budgetReservation.status !== "held")
			throw new Error(
				"existing terminal or uncertain commitment cannot authorize a new execution",
			);
		if (
			!paidContextCurrent() ||
			toJsonString(HostingQuoteSchema, reservedQuote) !== expectedQuote ||
			toJsonString(BudgetIdentitySchema, reservedIdentity) !==
				expectedIdentity ||
			toJsonString(HostingPolicyProofSchema, proof) !== expectedProof
		)
			throw new Error(
				"hosting evidence changed while the hold was created; reconcile reservation",
			);
		validateHostingQuote(quote, context.now());
		if (!paidContextCurrent())
			throw new Error(
				"hosting context changed during final freshness check; reconcile reservation",
			);
		hostingQuote = quote;
		hostingPolicyProof = policyProof;
	}

	append(
		yardEvent(YARD_EVENTS.PlacementRequested, {
			requestId: request.requestId,
			bindleName: request.bindleName,
			ownerTenantId,
			selectionMode: request.yard.selectionMode,
			requestedYardId: request.yard.requestedYardId,
			requestedLayout: request.yard.requestedLayout,
		}),
	);

	// Zero-config: seed a ready local yard via facts when inventory empty.
	if (
		deps.seedLocalYard !== false &&
		Object.keys(foldState.yards).length === 0 &&
		isLocalProvider(request.yard.requestedLayout.providerId ?? "local")
	) {
		const providerId = request.yard.requestedLayout.providerId ?? "local";
		const yard = localYardInstance({
			yardId: request.yard.requestedYardId ?? `yard:local-${providerId}`,
			ownerTenantId,
			providerId,
			componentHosts: ["local", "wasm", "oci"],
		});
		append(yardEvent(YARD_EVENTS.Registered, { yard }));
		append(
			yardEvent(YARD_EVENTS.Ready, {
				yardId: yard.yardId,
			}),
		);
	}

	const snapshot = inventorySnapshotFromFold(foldState);
	let initialCosts: ReadonlyMap<string, number>;
	try {
		initialCosts = economicCosts(snapshot.yards);
	} catch (error) {
		return rejectResult(
			foldState,
			emitted,
			"billing",
			"hosting-budget-evidence-unavailable",
			error instanceof Error
				? error.message
				: "hosting budget evidence unavailable",
		);
	}
	const match = matchYard(request.yard, snapshot, {
		ownerTenantId,
		objective: request.objective,
		bindleRuntimes: request.bindleRequirements.runtimes,
		contributingPolicyIds: ["yard-match"],
		economicCosts: initialCosts,
	});

	append(
		yardEvent(YARD_EVENTS.MatchDecided, {
			requestId: request.requestId,
			match,
		}),
	);

	let selectedYardId = match.winnerYardId;
	let generationAttemptId: string | undefined;
	let generationPlanHash: ContentHash | undefined;
	let generationAuthorityCurrent: (() => boolean) | undefined;
	const rejectAfterGeneration = (
		plane: string,
		code: string,
		message: string,
	) => {
		const marked = generationAttemptId ? markGenerationUncertain() : true;
		return rejectResult(
			foldState,
			emitted,
			plane,
			code,
			`${message}${marked ? "" : "; uncertain status could not be recorded; reconcile the hold"}`,
		);
	};
	let runtimeSnapshotMethod: typeof runtimeCatalog.snapshot;
	let runtimeSnapshot: ReturnType<typeof runtimeCatalog.snapshot>;
	try {
		runtimeSnapshotMethod = runtimeCatalog.snapshot;
		runtimeSnapshot = runtimeSnapshotMethod.call(runtimeCatalog);
	} catch (error) {
		return rejectResult(
			foldState,
			emitted,
			"placement",
			"yard-runtime-catalog-unavailable",
			error instanceof Error
				? error.message
				: "Yard runtime catalog unavailable",
		);
	}

	if (match.outcome === "generation-required") {
		const runtimeSnapshotDigest = contentHashOf(runtimeSnapshot);
		const generationPolicy =
			generationPolicyInput ?? DEFAULT_YARD_GENERATION_POLICY;
		const generationPolicyDigest = contentHashOf(generationPolicy);
		const genDecision = planYardGeneration({
			ownerTenantId,
			requestedLayout: request.yard.requestedLayout,
			runtimeCatalog: runtimeSnapshot,
			policy: generationPolicy,
			allowGenerationRequested: request.yard.allowGenerationRequested,
			attemptId: `gen-${request.requestId}`,
		});
		if (!genDecision.allowed) {
			append(
				yardEvent(YARD_EVENTS.PlacementRejected, {
					requestId: request.requestId,
					code: "yard-generation-denied",
					reasonCodes: ["yard-generation-denied"],
					message: genDecision.reason,
				}),
			);
			return rejectResult(
				foldState,
				emitted,
				"policy",
				"yard-generation-denied",
				genDecision.reason,
			);
		}
		if (
			request.yard.selectionMode === "exact" &&
			request.yard.requestedYardId !== genDecision.plan.expectedYardId
		) {
			append(
				yardEvent(YARD_EVENTS.PlacementRejected, {
					requestId: request.requestId,
					code: "yard-generation-exact-id-mismatch",
					reasonCodes: ["yard-generation-exact-id-mismatch"],
				}),
			);
			return rejectResult(
				foldState,
				emitted,
				"placement",
				"yard-generation-exact-id-mismatch",
				"generated Yard would not match the exact requested Yard",
			);
		}
		if (
			selectOrGenerateCamp(request, genDecision.plan.expectedYardId) ===
			undefined
		) {
			append(
				yardEvent(YARD_EVENTS.PlacementRejected, {
					requestId: request.requestId,
					code: "camp-yard-mismatch",
					reasonCodes: ["camp-yard-mismatch"],
					message: "requested Camp is not a direct child of the planned Yard",
				}),
			);
			return rejectResult(
				foldState,
				emitted,
				"placement",
				"camp-yard-mismatch",
				"requested Camp is not a direct child of the planned Yard",
			);
		}
		const generationPlanCurrent = () => {
			try {
				const { planHash, ...planBody } = genDecision.plan;
				return contentHashOf(planBody) === planHash;
			} catch {
				return false;
			}
		};
		const connectors = connectorsInput ?? defaultYardGenerationConnectors();
		const connectorLookup = connectors.get;
		let selectedConnector: YardGenerationConnector | undefined;
		try {
			selectedConnector = connectors.get(genDecision.plan.generatorConnectorId);
		} catch {
			return rejectResult(
				foldState,
				emitted,
				"placement",
				"yard-generation-denied",
				"generation connector unavailable",
			);
		}
		if (
			!selectedConnector ||
			selectedConnector.id !== genDecision.plan.generatorConnectorId
		)
			return rejectResult(
				foldState,
				emitted,
				"placement",
				"yard-generation-denied",
				"generation connector missing or mismatched",
			);
		const selectedId = selectedConnector.id;
		const selectedKind = selectedConnector.kind;
		const selectedPlan = selectedConnector.plan;
		const selectedProvision = selectedConnector.provision;
		const selectedInspect = selectedConnector.inspect;
		const selectedCompensate = selectedConnector.compensate;
		// SAFETY: connectors may expose this optional provider-signal extension.
		const selectedSignals = (
			selectedConnector as YardGenerationConnector & {
				signalsFor?: (
					id: string,
				) => readonly { kind: string; payload: JsonObject }[];
			}
		).signalsFor;
		generationAuthorityCurrent = () => {
			try {
				if (
					deps.generationPolicy !== generationPolicyInput ||
					deps.runtimeCatalog !== runtimeCatalogInput ||
					deps.connectors !== connectorsInput ||
					runtimeCatalog.snapshot !== runtimeSnapshotMethod ||
					connectors.get !== connectorLookup ||
					contentHashOf(generationPolicy) !== generationPolicyDigest ||
					contentHashOf(runtimeCatalog.snapshot()) !== runtimeSnapshotDigest ||
					!generationPlanCurrent()
				)
					return false;
				const nowConnector = connectors.get(
					genDecision.plan.generatorConnectorId,
				);
				// Registry and snapshot callbacks can themselves change authority.
				// Recheck their inputs after invoking them before allowing an effect.
				return (
					nowConnector === selectedConnector &&
					nowConnector.id === selectedId &&
					nowConnector.kind === selectedKind &&
					nowConnector.plan === selectedPlan &&
					nowConnector.provision === selectedProvision &&
					nowConnector.inspect === selectedInspect &&
					nowConnector.compensate === selectedCompensate &&
					// SAFETY: compare the same optional extension captured above.
					(nowConnector as YardGenerationConnector & { signalsFor?: unknown })
						.signalsFor === selectedSignals &&
					deps.generationPolicy === generationPolicyInput &&
					deps.runtimeCatalog === runtimeCatalogInput &&
					deps.connectors === connectorsInput &&
					contentHashOf(generationPolicy) === generationPolicyDigest &&
					contentHashOf(runtimeCatalog.snapshot()) === runtimeSnapshotDigest &&
					generationPlanCurrent() &&
					paidContextCurrent() &&
					deps.generationPolicy === generationPolicyInput &&
					deps.runtimeCatalog === runtimeCatalogInput &&
					deps.connectors === connectorsInput &&
					runtimeCatalog.snapshot === runtimeSnapshotMethod &&
					connectors.get === connectorLookup &&
					contentHashOf(generationPolicy) === generationPolicyDigest &&
					selectedConnector.provision === selectedProvision &&
					selectedConnector.inspect === selectedInspect
				);
			} catch {
				return false;
			}
		};
		let inspectGenerationOnly = false;
		generationPlanHash = genDecision.plan.planHash;
		const planned = placeResourcesUnderYard(
			request,
			genDecision.plan.providerId,
			deps.catalog,
		);
		if ("error" in planned)
			return rejectResult(
				foldState,
				emitted,
				"placement",
				planned.code,
				planned.error,
			);
		try {
			await admitHosting(
				genDecision.plan.expectedYardId,
				genDecision.plan.providerId,
				planned.decisions,
				generationPlanHash,
			);
			if (!generationAuthorityCurrent())
				throw new Error(
					"generation authority changed after quote approval; reconcile reservation",
				);
			const financial = deps.hostingBudget;
			if (financial && budgetReservation && hostingQuote) {
				if (!paidContextCurrent() || !generationAuthorityCurrent())
					throw new Error(
						"hosting context changed before generation claim; reconcile reservation",
					);
				const now = financial.now();
				validateHostingQuote(hostingQuote, now);
				const head = financial.authority.read(now);
				const previous = financial.authority.lookup(reservationId);
				inspectGenerationOnly = Boolean(previous?.executionDigest);
				if (!paidContextCurrent() || !generationAuthorityCurrent())
					throw new Error(
						"hosting context changed before generation claim; reconcile reservation",
					);
				budgetReservation = financial.authority.claimExecution({
					reservationId,
					requestDigest,
					executionDigest: contentHashOf({
						kind: "yard-generation",
						requestDigest,
						planHash: genDecision.plan.planHash,
					}),
					expectedSeq: head.seq,
				});
				// A durable claim may wait for a database writer past quote expiry.
				validateHostingQuote(hostingQuote, financial.now());
				if (!paidContextCurrent())
					throw new Error(
						"hosting context changed after generation claim; reconcile reservation",
					);
			}
		} catch (error) {
			return rejectResult(
				foldState,
				emitted,
				"billing",
				"hosting-budget-admission-denied",
				error instanceof Error
					? error.message
					: "hosting budget admission failed",
			);
		}

		append(
			yardEvent(YARD_EVENTS.GenerationRequested, {
				attemptId: genDecision.plan.attemptId,
				idempotencyKey: genDecision.plan.idempotencyKey,
				providerId: genDecision.plan.providerId,
				runtimeId: genDecision.plan.runtimeId,
				expectedYardId: genDecision.plan.expectedYardId,
			}),
		);
		append(
			yardEvent(YARD_EVENTS.GenerationReserved, {
				attemptId: genDecision.plan.attemptId,
				idempotencyKey: genDecision.plan.idempotencyKey,
				providerId: genDecision.plan.providerId,
				runtimeId: genDecision.plan.runtimeId,
				expectedYardId: genDecision.plan.expectedYardId,
			}),
		);

		// Pin the actual callable methods so a registry lookup cannot redirect an
		// already authorized provider operation between the final check and call.
		const pinnedConnector: YardGenerationConnector = {
			id: selectedId,
			kind: selectedKind,
			plan: (input) => selectedPlan.call(selectedConnector, input),
			provision: (plan) => selectedProvision.call(selectedConnector, plan),
			inspect: (id) => selectedInspect.call(selectedConnector, id),
		};
		const saga = createYardGenerationSaga({
			connectors: new Map([
				[genDecision.plan.generatorConnectorId, pinnedConnector],
			]),
		});
		append(
			yardEvent(YARD_EVENTS.GenerationStarted, {
				attemptId: genDecision.plan.attemptId,
				idempotencyKey: genDecision.plan.idempotencyKey,
				providerId: genDecision.plan.providerId,
				runtimeId: genDecision.plan.runtimeId,
				expectedYardId: genDecision.plan.expectedYardId,
			}),
		);

		let genResult: Awaited<ReturnType<typeof saga.run>>;
		try {
			if (!generationAuthorityCurrent())
				throw new Error(
					"generation authority changed before provider operation",
				);
			if (inspectGenerationOnly) {
				// The claim may have committed before a lost provider acknowledgement.
				// Reopening a saga must inspect that operation rather than provision again.
				genResult = await selectedInspect.call(
					selectedConnector,
					genDecision.plan.attemptId,
				);
			} else genResult = await saga.run(genDecision.plan);
		} catch (error) {
			const marked = markGenerationUncertain();
			return rejectResult(
				foldState,
				emitted,
				"placement",
				"yard-generation-uncertain",
				`${error instanceof Error ? error.message : "generation outcome uncertain"}${marked ? "" : "; uncertain status could not be recorded; reconcile the hold"}`,
			);
		}
		try {
			if (budgetReservation && hostingQuote && hostingBudget) {
				if (!paidContextCurrent() || !generationAuthorityCurrent())
					throw new Error(
						"hosting or generation authority changed during generation",
					);
				validateHostingQuote(hostingQuote, hostingBudget.now());
				if (!paidContextCurrent())
					throw new Error("hosting context changed after generation");
			}
		} catch (error) {
			const marked = markGenerationUncertain();
			return rejectResult(
				foldState,
				emitted,
				"placement",
				"yard-generation-uncertain",
				`${error instanceof Error ? error.message : "generation context changed"}${marked ? "" : "; uncertain status could not be recorded; reconcile the hold"}`,
			);
		}
		generationAttemptId = genDecision.plan.attemptId;
		if (genResult.attemptId !== genDecision.plan.attemptId) {
			append(
				yardEvent(YARD_EVENTS.PlacementRejected, {
					requestId: request.requestId,
					code: "yard-generation-attempt-mismatch",
					reasonCodes: ["yard-generation-attempt-mismatch"],
				}),
			);
			return rejectAfterGeneration(
				"placement",
				"yard-generation-attempt-mismatch",
				"provider returned a different generation attempt",
			);
		}
		if (
			genResult.yardId &&
			genResult.yardId !== genDecision.plan.expectedYardId
		) {
			append(
				yardEvent(YARD_EVENTS.PlacementRejected, {
					requestId: request.requestId,
					code: "yard-generation-id-mismatch",
					reasonCodes: ["yard-generation-id-mismatch"],
				}),
			);
			return rejectAfterGeneration(
				"placement",
				"yard-generation-id-mismatch",
				"provider returned a different Yard than the generation plan",
			);
		}

		// Feed the pinned connector's progress signals through the provider fold.
		try {
			if (selectedSignals) {
				appendProviderSignals(
					genDecision.plan.providerId,
					selectedSignals.call(selectedConnector, genDecision.plan.attemptId),
					{
						attemptId: genDecision.plan.attemptId,
						idempotencyKey: genDecision.plan.idempotencyKey,
						yardId: genDecision.plan.expectedYardId,
						runtimeId: genDecision.plan.runtimeId,
						ownerTenantId,
					},
				);
			}
		} catch (error) {
			return rejectAfterGeneration(
				"placement",
				"yard-generation-uncertain",
				error instanceof Error
					? error.message
					: "generation signals unavailable",
			);
		}

		if (genResult.status === "failed" || !genResult.yardId) {
			append(
				yardEvent(YARD_EVENTS.GenerationFailed, {
					attemptId: genDecision.plan.attemptId,
					idempotencyKey: genDecision.plan.idempotencyKey,
					providerId: genDecision.plan.providerId,
					failure: genResult.failure ?? {
						code: "yard-generation-failed",
						message: "yard generation failed",
						retryable: false,
					},
				}),
			);
			append(
				yardEvent(YARD_EVENTS.PlacementRejected, {
					requestId: request.requestId,
					code: genResult.failure?.code ?? "yard-generation-failed",
					reasonCodes: [genResult.failure?.code ?? "yard-generation-failed"],
				}),
			);
			return rejectAfterGeneration(
				"placement",
				genResult.failure?.code ?? "yard-generation-failed",
				genResult.failure?.message ?? "yard generation failed",
			);
		}

		// A non-ready result needs a ready signal for this exact attempt and Yard.
		const readyAttempt =
			foldState.generationAttempts[genDecision.plan.attemptId];
		const readySignalMatches =
			foldState.yards[genResult.yardId]?.status === "ready" &&
			readyAttempt?.status === "ready" &&
			readyAttempt.yardId === genDecision.plan.expectedYardId &&
			readyAttempt.expectedYardId === genDecision.plan.expectedYardId &&
			readyAttempt.idempotencyKey === genDecision.plan.idempotencyKey &&
			readyAttempt.providerId === genDecision.plan.providerId &&
			readyAttempt.runtimeId === genDecision.plan.runtimeId;
		if (!readySignalMatches && genResult.status !== "ready") {
			append(
				yardEvent(YARD_EVENTS.PlacementRejected, {
					requestId: request.requestId,
					code: "yard-generation-not-ready",
					reasonCodes: ["yard-generation-not-ready"],
				}),
			);
			return rejectAfterGeneration(
				"placement",
				"yard-generation-not-ready",
				"provider has not reported a ready Yard",
			);
		}
		// If the connector reports ready without signals, complete registration.
		if (
			!foldState.yards[genResult.yardId]?.status ||
			foldState.yards[genResult.yardId]?.status !== "ready"
		) {
			const providerId = genDecision.plan.providerId;
			append(
				yardEvent(YARD_EVENTS.Registered, {
					yard: localYardInstance({
						yardId: genResult.yardId,
						ownerTenantId,
						providerId,
						runtimeId: genDecision.plan.runtimeId,
					}),
				}),
			);
			append(
				yardEvent(YARD_EVENTS.AttestationStarted, {
					yardId: genResult.yardId,
				}),
			);
			append(yardEvent(YARD_EVENTS.Attested, { yardId: genResult.yardId }));
			append(
				yardEvent(YARD_EVENTS.Ready, {
					yardId: genResult.yardId,
					attemptId: genDecision.plan.attemptId,
				}),
			);
		}

		const rematchSnapshot = inventorySnapshotFromFold(foldState);
		let rematchCosts: ReadonlyMap<string, number>;
		try {
			rematchCosts = economicCosts(rematchSnapshot.yards);
		} catch (error) {
			const marked = markGenerationUncertain();
			return rejectResult(
				foldState,
				emitted,
				"billing",
				"hosting-budget-evidence-unavailable",
				`${error instanceof Error ? error.message : "hosting budget evidence unavailable"}${marked ? "" : "; uncertain status could not be recorded; reconcile the hold"}`,
			);
		}
		const rematch = matchYard(request.yard, rematchSnapshot, {
			ownerTenantId,
			objective: request.objective,
			bindleRuntimes: request.bindleRequirements.runtimes,
			economicCosts: rematchCosts,
		});
		append(
			yardEvent(YARD_EVENTS.MatchDecided, {
				requestId: request.requestId,
				match: rematch,
				phase: "post-generation",
			}),
		);
		if (rematch.outcome !== "existing-yard" || !rematch.winnerYardId) {
			append(
				yardEvent(YARD_EVENTS.PlacementRejected, {
					requestId: request.requestId,
					code: "yard-rematch-failed",
					reasonCodes: ["yard-rematch-failed"],
				}),
			);
			return rejectAfterGeneration(
				"placement",
				"yard-rematch-failed",
				"generated yard did not become selectable",
			);
		}
		selectedYardId = rematch.winnerYardId;
	}

	if (match.outcome === "rejected" && !selectedYardId) {
		append(
			yardEvent(YARD_EVENTS.PlacementRejected, {
				requestId: request.requestId,
				code: "yard-match-rejected",
				reasonCodes: ["yard-match-rejected"],
				message: match.rationale,
			}),
		);
		return rejectAfterGeneration(
			"placement",
			"yard-match-rejected",
			match.rationale,
		);
	}
	if (!selectedYardId) {
		append(
			yardEvent(YARD_EVENTS.PlacementRejected, {
				requestId: request.requestId,
				code: "no-yard-selected",
				reasonCodes: ["no-yard-selected"],
			}),
		);
		return rejectAfterGeneration(
			"placement",
			"no-yard-selected",
			"no yard selected",
		);
	}

	const workingSnapshot = inventorySnapshotFromFold(foldState);
	const yard = workingSnapshot.yards.find((y) => y.yardId === selectedYardId);
	if (yard?.status !== "ready") {
		append(
			yardEvent(YARD_EVENTS.PlacementRejected, {
				requestId: request.requestId,
				code: "yard-not-ready",
				reasonCodes: ["yard-not-ready"],
			}),
		);
		return rejectAfterGeneration(
			"placement",
			"yard-not-ready",
			`yard ${selectedYardId} is not ready`,
		);
	}

	// Camp placement inside selected yard.
	const campId = selectOrGenerateCamp(request, yard.yardId);
	if (campId === undefined) {
		append(
			yardEvent(YARD_EVENTS.PlacementRejected, {
				requestId: request.requestId,
				code: "camp-yard-mismatch",
				reasonCodes: ["camp-yard-mismatch"],
				message: "requested Camp is not a direct child of the selected Yard",
			}),
		);
		return rejectAfterGeneration(
			"placement",
			"camp-yard-mismatch",
			"requested Camp is not a direct child of the selected Yard",
		);
	}

	// Resolvers constrained to yard provider (includes event-store slot).
	let pins: ReturnType<typeof composeResolverPins>["pins"];
	try {
		({ pins } = composeResolverPins({
			providerId: yard.providerId,
			yardDefaults: EMPTY_RESOLVER_CONFIG,
			campConfig: EMPTY_RESOLVER_CONFIG,
			providerDefaults: defaultProviderResolvers(yard.providerId),
		}));
	} catch (error) {
		return rejectAfterGeneration(
			"placement",
			"resolver-composition-failed",
			error instanceof Error ? error.message : "resolver composition failed",
		);
	}

	// Residual resources: all under selected yard provider only (no cross-yard split).
	const placements = placeResourcesUnderYard(
		request,
		yard.providerId,
		deps.catalog,
	);
	if ("error" in placements) {
		append(
			yardEvent(YARD_EVENTS.PlacementRejected, {
				requestId: request.requestId,
				code: placements.code,
				reasonCodes: [placements.code],
				message: placements.error,
			}),
		);
		return rejectAfterGeneration(
			"placement",
			placements.code,
			placements.error,
		);
	}
	try {
		await admitHosting(
			yard.yardId,
			yard.providerId,
			placements.decisions,
			generationPlanHash,
		);
		if (generationAuthorityCurrent && !generationAuthorityCurrent())
			throw new Error("generation authority changed before receipt");
		if (hostingQuote && hostingBudget) {
			if (!paidContextCurrent())
				throw new Error(
					"hosting context changed before receipt; reconcile reservation",
				);
			validateHostingQuote(hostingQuote, hostingBudget.now());
			if (!paidContextCurrent())
				throw new Error(
					"hosting context changed during receipt freshness check; reconcile reservation",
				);
		}
		if (
			localHostingProof &&
			(!localContextCurrent() ||
				localHostingProof.bindingDigest !==
					contentHashOf({
						brokerId,
						requestDigest,
						catalogHash,
						yardId: yard.yardId,
						providerId: yard.providerId,
						ownerTenantId,
						placements: placements.decisions,
					}))
		)
			throw new Error("local hosting context changed before receipt");
	} catch (error) {
		return rejectAfterGeneration(
			"billing",
			"hosting-budget-admission-denied",
			error instanceof Error
				? error.message
				: "hosting budget admission failed",
		);
	}

	const executionUnits = buildExecutionUnits({
		yardId: yard.yardId,
		providerId: yard.providerId,
		campId,
		bindleName: request.bindleName,
		resourcePlacements: placements.decisions,
	});

	const receiptBody = {
		schemaVersion: YARD_PLACEMENT_RECEIPT_SCHEMA,
		requestId: request.requestId,
		brokerId: deps.brokerId,
		selectionMode: request.yard.selectionMode,
		// SAFETY: assertion required at this I/O or test boundary.
		requestedLayoutHash: contentHashOf(
			request.yard.requestedLayout,
		) as ContentHash,
		inventoryHash: workingSnapshot.contentHash,
		runtimeCatalogHash: runtimeSnapshot.contentHash,
		selectedYardId: yard.yardId,
		selectedProviderId: yard.providerId,
		selectedCampId: campId,
		...(generationAttemptId !== undefined
			? { generationAttemptId }
			: undefined),
		match: {
			...match,
			...(selectedYardId !== match.winnerYardId
				? { winnerYardId: selectedYardId, outcome: "existing-yard" as const }
				: undefined),
		},
		executionUnits,
		contributingPolicyIds: Object.freeze([
			...match.contributingPolicyIds,
			deps.generationPolicy?.id ?? DEFAULT_YARD_GENERATION_POLICY.id,
			`${yard.providerId}.yard.event-store/v1`,
		]),
		resolverPins: pins,
	};

	if (budgetReservation && hostingQuote)
		Object.assign(receiptBody, { budgetReservation, hostingQuote });
	if (hostingPolicyProof) Object.assign(receiptBody, { hostingPolicyProof });
	if (localHostingProof) Object.assign(receiptBody, { localHostingProof });

	const receipt: YardPlacementReceipt = Object.freeze({
		...receiptBody,
		// SAFETY: assertion required at this I/O or test boundary.
		contentHash: contentHashOf(receiptBody) as ContentHash,
	});

	append(
		yardEvent(YARD_EVENTS.PlacementResolved, {
			requestId: request.requestId,
			selectedYardId: yard.yardId,
			selectedProviderId: yard.providerId,
			selectedCampId: campId,
			...(generationAttemptId !== undefined
				? { generationAttemptId }
				: undefined),
			receiptHash: receipt.contentHash,
			receipt,
		}),
	);

	return {
		outcome: "resolved",
		receipt,
		placements: placements.decisions,
		...(generationAttemptId !== undefined
			? { generationAttemptId }
			: undefined),
		events: Object.freeze([...emitted]),
		foldState,
	};
}

export function parseBindleDeploymentRequest(
	input: JsonValue | undefined,
): BindleDeploymentRequest {
	if (!input || !isJsonObject(input) || Array.isArray(input)) {
		throw new TypeError("bindle deployment request must be an object");
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = input as JsonObject;
	if (raw.schemaVersion !== BINDLE_DEPLOYMENT_REQUEST_SCHEMA) {
		throw new TypeError(
			`schemaVersion must be ${BINDLE_DEPLOYMENT_REQUEST_SCHEMA}`,
		);
	}
	if (!isJsonString(raw.requestId) || !raw.requestId) {
		throw new TypeError("requestId required");
	}
	if (!isJsonString(raw.bindleName) || !raw.bindleName) {
		throw new TypeError("bindleName required");
	}
	// Reject bindle-level provider selection if smuggled in.
	if ("provider" in raw || "providerId" in raw) {
		throw Object.assign(
			new Error(
				"bindle-provider-selection-forbidden: provider belongs on Yard placement request",
			),
			{ code: "bindle-provider-selection-forbidden" },
		);
	}

	// SAFETY: assertion required at this I/O or test boundary.
	const yardRaw = raw.yard as JsonObject;
	if (!yardRaw || !isJsonObject(yardRaw)) {
		throw new TypeError("yard placement request required");
	}
	if (
		!isJsonNumber(raw.spendEstimateUsd) ||
		!Number.isFinite(raw.spendEstimateUsd) ||
		raw.spendEstimateUsd < 0
	)
		throw new TypeError(
			"spendEstimateUsd must be present, finite, and nonnegative",
		);
	if (
		yardRaw.selectionMode === "exact" &&
		yardRaw.requestedYardId === undefined
	)
		throw new TypeError("exact Yard selection requires requestedYardId");
	if (
		yardRaw.requestedYardId !== undefined &&
		(!isJsonString(yardRaw.requestedYardId) || !yardRaw.requestedYardId.trim())
	)
		throw new TypeError("requestedYardId must be a nonempty string");
	validateRequestedYardLayout(yardRaw.requestedLayout);
	const yard: YardPlacementRequest = Object.freeze({
		requestId: isJsonString(yardRaw.requestId)
			? yardRaw.requestId
			: `yard-req-${raw.requestId}`,
		selectionMode: parseSelectionMode(yardRaw.selectionMode),
		...(isJsonString(yardRaw.requestedYardId)
			? { requestedYardId: yardRaw.requestedYardId }
			: undefined),
		requestedLayout: parseYardLayout(
			cloneAsJson(yardRaw.requestedLayout ?? emptyYardLayout()),
		),
		bindleManifestHash: asHash(yardRaw.bindleManifestHash ?? raw.manifestHash),
		bindleRequirementsHash: asHash(
			yardRaw.bindleRequirementsHash ??
				contentHashOf(raw.bindleRequirements ?? {}),
		),
		allowGenerationRequested: yardRaw.allowGenerationRequested === true,
	});

	if (
		raw.bindleRequirements !== undefined &&
		!isJsonObject(raw.bindleRequirements)
	)
		throw new TypeError("bindleRequirements must be an object");
	const reqs = isJsonObject(raw.bindleRequirements)
		? raw.bindleRequirements
		: {};
	validateConstraintLists(
		reqs,
		["require", "prefer", "runtimes"],
		"bindleRequirements",
	);
	validateConstraintLabels(reqs.labels, "bindleRequirements.labels");
	if (raw.resources !== undefined && !Array.isArray(raw.resources))
		throw new TypeError("resources must be an array");
	const resourceIds = new Set<string>();
	const resources = (Array.isArray(raw.resources) ? raw.resources : []).map(
		(row) => {
			if (!isJsonObject(row) || Array.isArray(row))
				throw new TypeError("resource must be an object");
			if (!isJsonString(row.resourceId) || !row.resourceId.trim())
				throw new TypeError("resource identity must be a nonempty string");
			if (resourceIds.has(row.resourceId))
				throw new TypeError(`duplicate resource identity ${row.resourceId}`);
			resourceIds.add(row.resourceId);
			if (!isJsonString(row.port) || !row.port.trim())
				throw new TypeError("resource port must be a nonempty string");
			if (row.features !== undefined && !Array.isArray(row.features))
				throw new TypeError("resource features must be an array");
			const features = (Array.isArray(row.features) ? row.features : []).map(
				(feature) => {
					if (!isJsonString(feature) || !feature.trim())
						throw new TypeError("resource feature must be a nonempty string");
					return feature;
				},
			);
			if (
				row.region !== undefined &&
				(!isJsonString(row.region) || !row.region.trim())
			)
				throw new TypeError("resource region must be a nonempty string");
			return Object.freeze({
				resourceId: row.resourceId,
				port: row.port,
				features: Object.freeze(features),
				...(isJsonString(row.region) ? { region: row.region } : undefined),
			});
		},
	);
	if (raw.camp !== undefined && !isJsonObject(raw.camp))
		throw new TypeError("camp must be an object");
	if (isJsonObject(raw.camp)) {
		if (raw.camp.selectionMode === "exact" && raw.camp.campId === undefined)
			throw new TypeError("exact Camp selection requires campId");
		if (
			raw.camp.campId !== undefined &&
			(!isJsonString(raw.camp.campId) || !raw.camp.campId.trim())
		)
			throw new TypeError("campId must be a nonempty string");
		validateRequestedCampLayout(raw.camp.layout, "camp.layout");
	}

	return Object.freeze({
		schemaVersion: BINDLE_DEPLOYMENT_REQUEST_SCHEMA,
		requestId: raw.requestId,
		bindleName: raw.bindleName,
		manifestHash: asHash(raw.manifestHash),
		bindleRequirements: Object.freeze({
			require: list(reqs.require),
			prefer: list(reqs.prefer),
			runtimes: list(reqs.runtimes),
			labels: stringMap(reqs.labels),
		}),
		yard,
		...(isJsonObject(raw.camp)
			? {
					camp: Object.freeze({
						selectionMode: parseSelectionMode(raw.camp.selectionMode),
						...(isJsonString(raw.camp.campId)
							? { campId: raw.camp.campId }
							: undefined),
						layout: parseCampLayout(raw.camp.layout),
					}),
				}
			: undefined),
		objective: isJsonString(raw.objective) ? raw.objective : "min-cost",
		spendEstimateUsd: raw.spendEstimateUsd,
		ownerTenantId: isJsonString(raw.ownerTenantId)
			? raw.ownerTenantId
			: "local",
		resources: Object.freeze(resources),
	});
}

export function buildDeploymentRequestFromParts(options: {
	readonly bindleName: string;
	readonly manifestHash?: ContentHash;
	readonly requirements?: BindleDeploymentRequest["bindleRequirements"];
	readonly yardId?: string;
	readonly providerId?: string;
	readonly selectionMode?: YardPlacementRequest["selectionMode"];
	readonly allowGeneration?: boolean;
	readonly resources: BindleDeploymentRequest["resources"];
	readonly ownerTenantId?: string;
	readonly objective?: string;
}): BindleDeploymentRequest {
	const requestId = `req-${randomUUID()}`;
	const requirements = options.requirements ?? {
		require: [],
		prefer: [],
		runtimes: [],
		labels: {},
	};
	const isLocal =
		!options.providerId ||
		options.providerId === "local" ||
		options.providerId === "@hobo/provider-local-host";
	const layout = parseYardLayout({
		...(options.providerId ? { providerId: options.providerId } : undefined),
		// Local zero-config hosts only; cloud yards declare their own substrate.
		...(isLocal
			? { componentHosts: ["local", "wasm", "oci"] }
			: { componentHosts: [] }),
	});
	const mode =
		options.selectionMode ??
		(options.yardId ? "exact" : "compatible-or-generate");
	return parseBindleDeploymentRequest(
		cloneAsJson({
			schemaVersion: BINDLE_DEPLOYMENT_REQUEST_SCHEMA,
			requestId,
			bindleName: options.bindleName,
			manifestHash: options.manifestHash ?? contentHashOf(options.bindleName),
			bindleRequirements: requirements,
			yard: {
				requestId: `yard-${requestId}`,
				selectionMode: mode,
				...(options.yardId ? { requestedYardId: options.yardId } : undefined),
				requestedLayout: layout,
				bindleManifestHash:
					options.manifestHash ?? contentHashOf(options.bindleName),
				bindleRequirementsHash: contentHashOf(requirements),
				allowGenerationRequested: options.allowGeneration === true,
			},
			objective: options.objective ?? "min-cost",
			spendEstimateUsd: 0,
			ownerTenantId: options.ownerTenantId ?? "local",
			resources: options.resources,
		}),
	);
}

function selectOrGenerateCamp(
	request: BindleDeploymentRequest,
	yardId: string,
): string | undefined {
	if (request.camp?.campId) {
		const campId = request.camp.campId;
		if (!campId.includes("/"))
			return campId === "." || campId === ".."
				? undefined
				: `${yardId}/${campId}`;
		const prefix = `${yardId}/`;
		if (!campId.startsWith(prefix)) return undefined;
		const child = campId.slice(prefix.length);
		if (!child.trim() || child.includes("/") || child === "." || child === "..")
			return undefined;
		return campId;
	}
	const env = request.camp?.layout.envType ?? "dev";
	return `${yardId}/camp:${env}`;
}

function placeResourcesUnderYard(
	request: BindleDeploymentRequest,
	providerId: string,
	catalog: BrokerCatalog,
):
	| { readonly decisions: readonly PlacementDecision[] }
	| { readonly error: string; readonly code: string } {
	const invalid = (code: string, error: string) => ({ code, error });
	let defs: ReturnType<BrokerCatalog["definitions"]>;
	let providers: Array<{ source: (typeof defs)[number]; provider: string }>;
	try {
		providers = catalog.definitions().map((source) => ({
			source,
			provider: source.providerId,
		}));
		defs = providers
			.filter((item) => item.provider === providerId || item.provider === "*")
			.map((item) => item.source);
	} catch {
		return invalid(
			"catalog-definition-invalid",
			"yard catalog could not be read",
		);
	}
	type Candidate = {
		source: (typeof defs)[number];
		id: string;
		provider: string;
		sku: string;
		unit: string;
		priceText: string;
		price: Decimal;
		regions: string[];
		region: string;
	};
	const evidence: Candidate[] = [];
	const decisions: PlacementDecision[] = [];
	for (const req of request.resources) {
		const candidates: Candidate[] = [];
		const ids = new Set<string>();
		let unit: string | undefined;
		for (const d of defs) {
			try {
				if (!Array.isArray(d.regions))
					return invalid(
						"catalog-definition-invalid",
						"yard regions must be an array",
					);
				const before = {
					id: d.id,
					provider: d.providerId,
					sku: d.cost.sku,
					unit: d.cost.unit,
					priceText: d.cost.marginalPrice,
					regions: [...d.regions],
				};
				if (before.provider !== providerId && before.provider !== "*")
					return invalid(
						"catalog-definition-invalid",
						"catalog provider changed during placement",
					);
				const verdict = d.satisfies({
					port: req.port,
					features: [...req.features],
				});
				if (!Array.isArray(d.regions))
					return invalid(
						"catalog-definition-invalid",
						"yard regions changed during capability check",
					);
				const after = {
					id: d.id,
					provider: d.providerId,
					sku: d.cost.sku,
					unit: d.cost.unit,
					priceText: d.cost.marginalPrice,
					regions: [...d.regions],
				};
				if (JSON.stringify(before) !== JSON.stringify(after))
					return invalid(
						"catalog-definition-invalid",
						"catalog definition changed during capability check",
					);
				if (verdict.kind !== "full") continue;
				if (req.region && !before.regions.includes(req.region)) continue;
				if (
					!isJsonString(before.id) ||
					!before.id.trim() ||
					!isJsonString(before.provider) ||
					!before.provider.trim() ||
					!isJsonString(before.sku) ||
					!before.sku.trim() ||
					!isJsonString(before.unit) ||
					!before.unit.trim() ||
					before.regions.length === 0 ||
					before.regions.some(
						(region) => !isJsonString(region) || !region.trim(),
					)
				)
					return invalid(
						"catalog-definition-invalid",
						"eligible yard definition lacks identity, SKU, unit or region",
					);
				if (ids.has(before.id))
					return invalid(
						"catalog-definition-conflict",
						"eligible yard definition identities must be distinct",
					);
				ids.add(before.id);
				const price = isJsonString(before.priceText)
					? parseDecimal(before.priceText)
					: undefined;
				if (!price || price.coefficient < 0n)
					return invalid(
						"catalog-price-invalid",
						"eligible yard price must be a nonnegative decimal",
					);
				if (unit !== undefined && unit !== before.unit)
					return invalid(
						"catalog-price-incomparable",
						"eligible yard prices use different units",
					);
				unit = before.unit;
				const region = req.region ?? before.regions[0];
				if (!region)
					return invalid(
						"catalog-definition-invalid",
						"eligible yard definition lacks a region",
					);
				candidates.push({ source: d, ...before, price, region });
			} catch {
				return invalid(
					"catalog-definition-invalid",
					"yard catalog capability or evidence check failed",
				);
			}
		}
		if (candidates.length === 0)
			return invalid(
				"no-definition-in-yard-provider",
				`no complete catalog definition for ${req.resourceId} under yard provider ${providerId}`,
			);
		candidates.sort(
			(a, b) =>
				compareDecimal(a.price, b.price) ||
				(a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
		);
		evidence.push(...candidates);
		const winner = first(candidates);
		decisions.push({
			resourceId: req.resourceId,
			providerId,
			definitionId: winner.id,
			region: winner.region,
			sku: winner.sku,
			unit: winner.unit,
			marginalPrice: winner.priceText,
		});
	}
	try {
		if (providers.some((item) => item.source.providerId !== item.provider))
			return invalid(
				"catalog-definition-invalid",
				"catalog provider changed during placement",
			);
	} catch {
		return invalid(
			"catalog-definition-invalid",
			"yard catalog could not be rechecked",
		);
	}
	for (const item of evidence) {
		try {
			if (!Array.isArray(item.source.regions))
				return invalid(
					"catalog-definition-invalid",
					"yard regions changed during placement",
				);
			if (
				JSON.stringify({
					id: item.source.id,
					provider: item.source.providerId,
					sku: item.source.cost.sku,
					unit: item.source.cost.unit,
					priceText: item.source.cost.marginalPrice,
					regions: [...item.source.regions],
				}) !==
				JSON.stringify({
					id: item.id,
					provider: item.provider,
					sku: item.sku,
					unit: item.unit,
					priceText: item.priceText,
					regions: item.regions,
				})
			)
				return invalid(
					"catalog-definition-invalid",
					"yard catalog changed during placement",
				);
		} catch {
			return invalid(
				"catalog-definition-invalid",
				"yard catalog could not be rechecked",
			);
		}
	}
	return { decisions: Object.freeze(decisions) };
}

function rejectResult(
	foldState: YardEventStoreState,
	emitted: readonly YardEvent[],
	plane: string,
	code: string,
	message: string,
): YardFirstPlacementResult {
	return {
		outcome: "rejected",
		placements: Object.freeze([]),
		reasons: Object.freeze([{ plane, code, message }]),
		events: Object.freeze([...emitted]),
		foldState,
	};
}

function validateConstraintLists(
	input: JsonObject,
	fields: readonly string[],
	path: string,
): void {
	for (const field of fields) {
		const value = input[field];
		if (value === undefined) continue;
		if (
			!Array.isArray(value) ||
			value.some((item) => !isJsonString(item) || !item.trim())
		)
			throw new TypeError(
				`${path}.${field} must be an array of nonempty strings`,
			);
	}
}

function validateConstraintLabels(
	value: JsonValue | undefined,
	path: string,
): void {
	if (value === undefined) return;
	if (
		!isJsonObject(value) ||
		Object.values(value).some((item) => !isJsonString(item))
	)
		throw new TypeError(`${path} must be a string map`);
}

function validateRequestedCampLayout(
	value: JsonValue | undefined,
	path: string,
): void {
	if (value === undefined) return;
	if (!isJsonObject(value)) throw new TypeError(`${path} must be an object`);
	for (const key of ["id", "env"] as const) {
		if (value[key] !== undefined && !isJsonString(value[key]))
			throw new TypeError(`${path}.${key} must be a string`);
	}
	if (
		value.envType !== undefined &&
		(!isJsonString(value.envType) ||
			!value.envType.trim() ||
			value.envType.includes("/"))
	)
		throw new TypeError("camp envType must be a nonempty path segment");
	validateConstraintLists(
		value,
		["require", "prefer", "runtimeRequirements"],
		path,
	);
	validateConstraintLabels(value.labels, `${path}.labels`);
}

function validateRequestedYardLayout(value: JsonValue | undefined): void {
	if (value === undefined) return;
	if (!isJsonObject(value))
		throw new TypeError("yard requestedLayout must be an object");
	for (const key of ["providerId", "runtimeId"] as const) {
		if (
			value[key] !== undefined &&
			(!isJsonString(value[key]) || !value[key].trim())
		)
			throw new TypeError(
				`yard requestedLayout.${key} must be a nonempty string`,
			);
	}
	validateConstraintLists(
		value,
		[
			"regions",
			"require",
			"prefer",
			"residency",
			"isolation",
			"network",
			"componentHosts",
		],
		"yard requestedLayout",
	);
	if (Array.isArray(value.residency)) {
		for (const entry of value.residency) {
			try {
				parseYardResidencyTag(entry);
			} catch {
				throw new TypeError(
					`yard requestedLayout.residency contains an invalid tag: ${String(entry)}`,
				);
			}
		}
	}
	validateConstraintLabels(value.labels, "yard requestedLayout.labels");
	if (value.properties !== undefined && !isJsonObject(value.properties))
		throw new TypeError("yard requestedLayout.properties must be an object");
	if (value.camps !== undefined) {
		if (!Array.isArray(value.camps))
			throw new TypeError("yard requestedLayout.camps must be an array");
		for (const camp of value.camps) {
			if (camp === null || camp === undefined)
				throw new TypeError(
					"yard requestedLayout.camps entries must be objects",
				);
			validateRequestedCampLayout(camp, "yard requestedLayout.camps entry");
		}
	}
}

function parseSelectionMode(
	value: JsonValue | undefined,
): YardPlacementRequest["selectionMode"] {
	if (
		value === "exact" ||
		value === "compatible" ||
		value === "compatible-or-generate"
	) {
		return value;
	}
	if (value === undefined) return "compatible";
	throw new TypeError(
		"selectionMode must be exact, compatible, or compatible-or-generate",
	);
}

function asHash(value: JsonValue | undefined): ContentHash {
	if (isJsonString(value) && value.startsWith("sha256:")) {
		// SAFETY: assertion required at this I/O or test boundary.
		return value as ContentHash;
	}
	return contentHashOf(value ?? null);
}

function list(value: JsonValue | undefined): readonly string[] {
	if (!Array.isArray(value)) return Object.freeze([]);
	return Object.freeze(
		[
			...new Set(
				value.filter((v): v is string => isJsonString(v) && v.length > 0),
			),
		].sort(),
	);
}

function stringMap(
	value: JsonValue | undefined,
): Readonly<Record<string, string>> {
	if (!value || !isJsonObject(value) || Array.isArray(value)) {
		return Object.freeze({});
	}
	const entries: Array<[string, string]> = [];
	// SAFETY: assertion required at this I/O or test boundary.
	for (const k of Object.keys(value as object).sort()) {
		// SAFETY: assertion required at this I/O or test boundary.
		const v = (value as JsonObject)[k];
		if (isJsonString(v)) entries.push([k, v]);
	}
	return Object.freeze(Object.fromEntries(entries));
}
