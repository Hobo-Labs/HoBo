import { randomUUID } from "node:crypto";
import { first } from "@hobo/core/total-access";
import {
	type BudgetAdmissionAuthority,
	type BudgetIdentity,
	type BudgetReservation,
	budgetIdentityKey,
	type HostingPolicyProof,
	type HostingQuote,
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
	parseYardLayout,
	YARD_PLACEMENT_RECEIPT_SCHEMA,
	type YardGenerationPolicy,
	type YardPlacementReceipt,
	type YardPlacementRequest,
} from "./types.js";

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
		identity: BudgetIdentity;
		now: string;
	}) =>
		| { gate: GateDecision; proof: HostingPolicyProof }
		| Promise<{ gate: GateDecision; proof: HostingPolicyProof }>;
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
	): void => {
		const resolver =
			foldRegistry.get(providerId) ??
			foldRegistry.get("local") ??
			first(
				createDefaultEventStoreFoldResolvers(),
				"createDefaultEventStoreFoldResolvers()",
			);
		for (const signal of signals) {
			const native: ProviderNativeSignal = {
				providerId,
				kind: signal.kind,
				// SAFETY: assertion required at this I/O or test boundary.
				payload: signal.payload as ProviderNativeSignal["payload"],
			};
			for (const event of resolver.normalize(native)) {
				append(event);
			}
		}
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

	const ownerTenantId = request.ownerTenantId || deps.ownerTenantId || "local";
	if (deps.ownerTenantId && deps.ownerTenantId !== ownerTenantId)
		return rejectResult(
			foldState,
			emitted,
			"policy",
			"owner-tenant-mismatch",
			"deployment owner differs from the authenticated tenant",
		);
	const runtimeCatalog = deps.runtimeCatalog ?? createYardRuntimeCatalog();
	const requestDigest = contentHashOf(request);
	const reservationId = `hosting:${deps.brokerId}:${request.requestId}`;
	let budgetReservation: BudgetReservation | undefined;
	let hostingQuote: HostingQuote | undefined;
	let hostingPolicyProof: HostingPolicyProof | undefined;
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
		try {
			ledger = context?.authority.read(context.now());
		} catch {
			return costs;
		}
		const previous = context?.authority.lookup(reservationId);
		for (const yard of yards) {
			if (
				!context &&
				isLocalProvider(yard.providerId) &&
				request.spendEstimateUsd === 0
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
			const quote = context.quotes.find(
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
	): Promise<void> {
		const context = deps.hostingBudget;
		if (
			!context &&
			isLocalProvider(providerId) &&
			request.spendEstimateUsd === 0
		)
			return;
		if (context?.authority.persistence !== "durable-cas")
			throw new Error("durable shared hosting budget authority required");
		const quote = context.quotes.find(
			(row) =>
				row.yardId === yardId &&
				row.providerId === providerId &&
				row.ownerTenantId === ownerTenantId &&
				row.requestDigest === requestDigest,
		);
		if (!quote) throw new Error("complete hosting quote missing");
		const ledger = context.authority.read(context.now());
		if (!ledger.identity) throw new Error("budget identity missing");
		if (!deps.authorizeHosting)
			throw new Error("bound hosting policy authorization required");
		const { gate, proof } = await deps.authorizeHosting({
			request,
			requestDigest,
			quote,
			identity: ledger.identity,
			now: context.now(),
		});
		if (
			(gate.effect !== "allow" && gate.effect !== "allow-degraded") ||
			proof.effect !== gate.effect ||
			!proof.obligationsSatisfied ||
			!proof.evidenceRef ||
			!proof.policyHash ||
			proof.requestDigest !== requestDigest ||
			proof.quoteId !== quote.quoteId ||
			!proof.identity ||
			budgetIdentityKey(proof.identity) !== budgetIdentityKey(ledger.identity)
		)
			throw new Error(
				"hosting policy denies, requires approval, or lacks bound fulfilled obligations",
			);
		budgetReservation = context.authority.reserve({
			reservationId,
			requestDigest,
			quote,
			identity: ledger.identity,
			expectedSeq: ledger.seq,
			now: context.now(),
		});
		if (budgetReservation.status !== "held")
			throw new Error(
				"existing terminal or uncertain commitment cannot authorize a new execution",
			);
		hostingQuote = quote;
		hostingPolicyProof = proof;
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
	const match = matchYard(request.yard, snapshot, {
		ownerTenantId,
		objective: request.objective,
		bindleRuntimes: request.bindleRequirements.runtimes,
		contributingPolicyIds: ["yard-match"],
		economicCosts: economicCosts(snapshot.yards),
	});

	append(
		yardEvent(YARD_EVENTS.MatchDecided, {
			requestId: request.requestId,
			match,
		}),
	);

	let selectedYardId = match.winnerYardId;
	let generationAttemptId: string | undefined;
	const runtimeSnapshot = runtimeCatalog.snapshot();

	if (match.outcome === "generation-required") {
		const genDecision = planYardGeneration({
			ownerTenantId,
			requestedLayout: request.yard.requestedLayout,
			runtimeCatalog: runtimeSnapshot,
			policy: deps.generationPolicy ?? DEFAULT_YARD_GENERATION_POLICY,
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
		let inspectGenerationOnly = false;
		try {
			await admitHosting(
				genDecision.plan.expectedYardId,
				genDecision.plan.providerId,
			);
			const financial = deps.hostingBudget;
			if (financial && budgetReservation && hostingQuote) {
				const now = financial.now();
				validateHostingQuote(hostingQuote, now);
				const head = financial.authority.read(now);
				const previous = financial.authority.lookup(reservationId);
				inspectGenerationOnly = Boolean(previous?.executionDigest);
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

		const connectors = deps.connectors ?? defaultYardGenerationConnectors();
		const saga = createYardGenerationSaga({ connectors });
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
			if (inspectGenerationOnly) {
				const connector = connectors.get(genDecision.plan.generatorConnectorId);
				if (!connector) throw new Error("claimed generation connector missing");
				// The claim may have committed before a lost provider acknowledgement.
				// Reopening a saga must inspect that operation rather than provision again.
				genResult = await connector.inspect(genDecision.plan.attemptId);
			} else genResult = await saga.run(genDecision.plan);
		} catch (error) {
			if (budgetReservation)
				deps.hostingBudget?.authority.uncertain(reservationId);
			return rejectResult(
				foldState,
				emitted,
				"placement",
				"yard-generation-uncertain",
				error instanceof Error ? error.message : "generation outcome uncertain",
			);
		}
		generationAttemptId = genDecision.plan.attemptId;

		// Feed connector progress signals through the provider fold resolver.
		// SAFETY: assertion required at this I/O or test boundary.
		const connector = connectors.get(genDecision.plan.generatorConnectorId) as
			| (YardGenerationConnector & {
					signalsFor?: (
						id: string,
					) => readonly { kind: string; payload: JsonObject }[];
			  })
			| undefined;
		if (connector?.signalsFor) {
			appendProviderSignals(
				genDecision.plan.providerId,
				connector.signalsFor(genDecision.plan.attemptId),
			);
		}

		if (genResult.status === "failed" || !genResult.yardId) {
			if (budgetReservation)
				deps.hostingBudget?.authority.uncertain(reservationId);
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
			return rejectResult(
				foldState,
				emitted,
				"placement",
				genResult.failure?.code ?? "yard-generation-failed",
				genResult.failure?.message ?? "yard generation failed",
			);
		}

		// If connector did not emit ready via signals, complete attestation path.
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

		const rematch = matchYard(
			request.yard,
			inventorySnapshotFromFold(foldState),
			{
				ownerTenantId,
				objective: request.objective,
				bindleRuntimes: request.bindleRequirements.runtimes,
				economicCosts: economicCosts(
					inventorySnapshotFromFold(foldState).yards,
				),
			},
		);
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
			return rejectResult(
				foldState,
				emitted,
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
		return rejectResult(
			foldState,
			emitted,
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
		return rejectResult(
			foldState,
			emitted,
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
		return rejectResult(
			foldState,
			emitted,
			"placement",
			"yard-not-ready",
			`yard ${selectedYardId} is not ready`,
		);
	}

	// Camp placement inside selected yard.
	const campId = selectOrGenerateCamp(request, yard.yardId);

	// Resolvers constrained to yard provider (includes event-store slot).
	const { pins } = composeResolverPins({
		providerId: yard.providerId,
		yardDefaults: EMPTY_RESOLVER_CONFIG,
		campConfig: EMPTY_RESOLVER_CONFIG,
		providerDefaults: defaultProviderResolvers(yard.providerId),
	});

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
		return rejectResult(
			foldState,
			emitted,
			"placement",
			placements.code,
			placements.error,
		);
	}
	try {
		await admitHosting(yard.yardId, yard.providerId);
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

	const residualDefinitionIds = placements.decisions.map((p) => p.definitionId);
	const executionUnits = buildExecutionUnits({
		yardId: yard.yardId,
		providerId: yard.providerId,
		campId,
		bindleName: request.bindleName,
		resourceIds: request.resources.map((r) => r.resourceId),
		residualDefinitionIds,
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

	// SAFETY: assertion required at this I/O or test boundary.
	const reqs = (raw.bindleRequirements ?? {}) as JsonObject;
	const resources = Array.isArray(raw.resources)
		? raw.resources.map((r) => {
				// SAFETY: assertion required at this I/O or test boundary.
				const row = r as JsonObject;
				return Object.freeze({
					resourceId: String(row.resourceId),
					port: String(row.port),
					features: Object.freeze(
						Array.isArray(row.features) ? row.features.map(String) : [],
					),
					...(isJsonString(row.region) ? { region: row.region } : undefined),
				});
			})
		: [];

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
						selectionMode: parseSelectionMode(
							raw.camp.selectionMode ?? "compatible",
						),
						...(isJsonString(raw.camp.campId)
							? { campId: raw.camp.campId }
							: undefined),
						layout: Object.freeze({
							require: list(
								isJsonObject(raw.camp.layout)
									? raw.camp.layout.require
									: undefined,
							),
							prefer: list(
								isJsonObject(raw.camp.layout)
									? raw.camp.layout.prefer
									: undefined,
							),
							labels: stringMap(
								isJsonObject(raw.camp.layout)
									? raw.camp.layout.labels
									: undefined,
							),
							runtimeRequirements: list(
								isJsonObject(raw.camp.layout)
									? raw.camp.layout.runtimeRequirements
									: undefined,
							),
						}),
					}),
				}
			: undefined),
		objective: isJsonString(raw.objective) ? raw.objective : "min-cost",
		spendEstimateUsd: isJsonNumber(raw.spendEstimateUsd)
			? raw.spendEstimateUsd
			: 0,
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
): string {
	if (request.camp?.campId) {
		return request.camp.campId.includes("/")
			? request.camp.campId
			: `${yardId}/${request.camp.campId}`;
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
	const defs = catalog
		.definitions()
		.filter((d) => d.providerId === providerId || d.providerId === "*");
	const decisions: PlacementDecision[] = [];

	for (const req of request.resources) {
		const candidates = defs.filter((d) => {
			const sat = d.satisfies({
				port: req.port,
				features: [...req.features],
			});
			return sat.kind === "full" || sat.kind === "partial";
		});
		if (candidates.length === 0) {
			// Wildcard fallback on same provider
			const any = defs.find((d) => d.port === "*");
			if (!any) {
				return {
					error: `no catalog definition for ${req.resourceId} under yard provider ${providerId}`,
					code: "no-definition-in-yard-provider",
				};
			}
			candidates.push(any);
		}
		// Deterministic pick: lowest marginal price then id.
		candidates.sort((a, b) => {
			const pa = Number(a.cost.marginalPrice);
			const pb = Number(b.cost.marginalPrice);
			if (pa !== pb) return pa - pb;
			return a.id < b.id ? -1 : 1;
		});
		const winner = first(candidates);
		// Enforce no silent cross-provider placement.
		if (winner.providerId !== providerId && winner.providerId !== "*") {
			return {
				error: `candidate ${winner.id} provider ${winner.providerId} != yard ${providerId}`,
				code: "cross-yard-split-forbidden",
			};
		}
		decisions.push({
			resourceId: req.resourceId,
			providerId,
			definitionId: winner.id,
			region: req.region ?? winner.regions[0] ?? "local",
			sku: winner.cost.sku,
			unit: winner.cost.unit,
			marginalPrice: winner.cost.marginalPrice,
		});
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
	return "compatible";
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
	const out: Record<string, string> = {};
	// SAFETY: assertion required at this I/O or test boundary.
	for (const k of Object.keys(value as object).sort()) {
		// SAFETY: assertion required at this I/O or test boundary.
		const v = (value as JsonObject)[k];
		if (isJsonString(v)) out[k] = v;
	}
	return Object.freeze(out);
}
