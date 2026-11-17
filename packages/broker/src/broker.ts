import { createHash } from "node:crypto";
import { clone } from "@bufbuild/protobuf";
import {
	compareDecimal,
	type Decimal,
	parseDecimal,
	type QuoteVector,
	QuoteVectorSchema,
} from "@hobo/pricing";
import type { ConnectorRegistry } from "./connector-registry.js";
import { deliverySubmittedBody } from "./delivery.js";
import type { BrokerEnvironment } from "./environments.js";
import { BROKER_EVENTS, type BrokerEvent, brokerEvent } from "./events.js";
import {
	cloneAsJson,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import {
	type BillingPlane,
	createBillingPlane,
	createDeliveryPlane,
	createGatekeeperGatePlane,
	type DeliveryPlane,
	type DeliveryTicket,
	type GatePlane,
	type GatePlaneOptions,
	toPolicyDecisionRequest,
} from "./planes.js";
import type { EffectivePlacementPolicy } from "./policies.js";
import {
	BrokerParseError,
	effectivePlacementPolicy,
	parseBrokerPolicySet,
	parseBrokerRequest,
	policyHashOf,
} from "./policies.js";
import {
	authorizeBillingSpend,
	type TrustedQuoteAttestation,
} from "./pricing-authorization.js";
import {
	canonicalResolutionJson,
	type ResolutionSignature,
	type ResolutionSigningKey,
	signResolution,
} from "./signing.js";
import {
	BROKER_SCHEMA_VERSION,
	type BrokerCatalog,
	type BrokerCatalogDefinition,
	type BrokerRequest,
	type PlacementDecision,
	type PolicyHash,
	type RejectionReason,
	type ResolutionReceipt,
	type ResolutionRejection,
	type ResourceRequirement,
	SCALE_DIRECTIONS,
	type ScaleDirection,
	type ScaleDirective,
} from "./types.js";

// The HoBo Broker actor. It consumes brokering commands (resolve, scale,
// deliver), selects work and obtains trusted pricing before the gate and
// billing planes, and emits decision facts. Explicit legacy estimate mode
// retains the prior gate, billing, placement order. It coordinates durable state through those events; it never
// mutates a query read model directly. Read models are folds over the emitted
// facts (see foldBrokerDecisions), with snapshot/restore for the read store.

/** Maximum complete placement plans evaluated by quote-backed routing. */
export const MAX_BROKER_QUOTE_PLANS = 128;

export interface BrokerResolution {
	outcome: "resolved" | "rejected";
	receipt?: ResolutionReceipt;
	rejection?: ResolutionRejection;
	// Ed25519 detached signature over the receipt/rejection's canonical JSON,
	// present when the broker is configured with a signing key.
	signature?: ResolutionSignature;
	events: BrokerEvent[];
}

/** Immutable work selected before host pricing and policy evaluation. */
export interface BrokerQuoteContext {
	readonly request: Readonly<BrokerRequest>;
	readonly placements: readonly Readonly<PlacementDecision>[];
	readonly catalogHash: string;
	readonly environmentDigest: string;
	readonly policyHash: PolicyHash;
	readonly stationId: string;
	readonly railHash: string;
	readonly bindingDigest: string;
}

/** The host authenticates the quote and guarantees that its bound covers this
 * exact work and its provider-side liability. Calls must not perform effects. */
export interface BrokerPricingAuthority {
	quote(
		context: BrokerQuoteContext,
	): QuoteVector | undefined | Promise<QuoteVector | undefined>;
	attest(
		context: BrokerQuoteContext,
		quote: QuoteVector,
	): TrustedQuoteAttestation | undefined;
}

export interface HoboBrokerDeps {
	policies: unknown;
	catalog: BrokerCatalog;
	connectors?: ConnectorRegistry;
	gatePlane?: GatePlane;
	gateOptions?: GatePlaneOptions;
	billingPlane?: BillingPlane;
	pricingAuthority?: BrokerPricingAuthority;
	/** Explicit compatibility mode: the host accepts caller-supplied estimates. */
	trustLegacyEstimates?: boolean;
	deliveryPlane?: DeliveryPlane;
	signingKey?: ResolutionSigningKey;
	/**
	 * Optional approved provider/catalog ceiling applied in addition to the
	 * active Rail (not a substitute for Station occupancy).
	 */
	environment?: BrokerEnvironment;
	/** Station occupancy — required. Conductor holds no durable Connection state. */
	stationId: string;
	/** Active Rail content hash — required on every resolve. */
	railHash: string;
}

export interface HoboBroker {
	brokerId: string;
	policyHash: PolicyHash;
	resolve(input: JsonValue | undefined): Promise<BrokerResolution>;
	scale(input: JsonValue | undefined): {
		directive: ScaleDirective;
		events: BrokerEvent[];
	};
	deliver(receipt: ResolutionReceipt): Promise<{
		ticket: DeliveryTicket;
		events: BrokerEvent[];
	}>;
}

export function createBroker(deps: HoboBrokerDeps): HoboBroker {
	if (!isJsonString(deps.stationId) || deps.stationId.length === 0) {
		throw new BrokerParseError(
			"station-missing",
			"station-missing: Conductor requires stationId (hobo station init)",
		);
	}
	if (!isJsonString(deps.railHash) || !deps.railHash.startsWith("sha256:")) {
		throw new BrokerParseError(
			"rail-inactive",
			"rail-inactive: Conductor requires active railHash (hobo station rails activate)",
		);
	}
	// Parse, don't validate: the policy document crosses the parser boundary
	// once; from here on the broker only ever sees the refined domain types.
	const policies = parseBrokerPolicySet(cloneAsJson(deps.policies));
	const policyHash = policyHashOf(policies);
	const gatePlane =
		deps.gatePlane ?? createGatekeeperGatePlane(deps.gateOptions ?? {});
	const billingPlane = deps.billingPlane ?? createBillingPlane();
	const deliveryPlane = deps.deliveryPlane ?? createDeliveryPlane();
	const stationId = deps.stationId;
	const railHash = deps.railHash;
	// A receipt can only be handed to delivery by the broker instance that
	// issued it. A durable, shared claim store is needed across restarts.
	const resolvingRequests = new Set<string>();
	const issuedResolutions = new Map<
		string,
		{
			canonical: string;
			receipt: ResolutionReceipt;
			catalogHash: string;
			environmentSnapshot: string;
			pricing?: {
				authority: BrokerPricingAuthority;
				quote: QuoteVector;
				context: BrokerQuoteContext;
				amount: number;
			};
			state: "ready" | "claimed";
		}
	>();

	function placementChoices(
		request: BrokerRequest,
		effective: EffectivePlacementPolicy,
		quoteAll: boolean,
	) {
		const approved = deps.environment?.approvedProviders;
		const definitions =
			approved !== undefined && approved.length > 0
				? deps.catalog
						.definitions()
						.filter((definition) => approved.includes(definition.providerId))
				: deps.catalog.definitions();
		const choices: PlacementDecision[][] = [];
		const reasons: RejectionReason[] = [];
		for (const requirement of request.requirements) {
			const placed = placeRequirement(
				requirement,
				definitions,
				effective,
				quoteAll,
			);
			if ("reason" in placed) reasons.push(placed.reason);
			else choices.push(placed.placements);
		}
		return { choices, reasons };
	}
	function selectPlacements(
		request: BrokerRequest,
		effective: EffectivePlacementPolicy,
	) {
		const { choices, reasons } = placementChoices(request, effective, false);
		const placements: PlacementDecision[] = [];
		for (const options of choices) {
			const selected = options[0];
			if (!selected)
				return {
					placements,
					reasons: [
						...reasons,
						{
							plane: "placement" as const,
							code: "no-eligible-provider",
							message: "no eligible placement",
						},
					],
				};
			placements.push(selected);
		}
		return { placements, reasons };
	}
	function enumeratePlans(
		request: BrokerRequest,
		effective: EffectivePlacementPolicy,
	) {
		const { choices, reasons } = placementChoices(request, effective, true);
		if (reasons.length) return { plans: [], reasons };
		let plans: PlacementDecision[][] = [[]];
		for (const options of choices) {
			if (
				options.length === 0 ||
				options.length > Math.floor(MAX_BROKER_QUOTE_PLANS / plans.length)
			) {
				return {
					plans: [],
					reasons: [
						{
							plane: "placement" as const,
							code: "quote-search-limit",
							message: `complete quote search exceeds ${MAX_BROKER_QUOTE_PLANS} candidate plans`,
						},
					],
				};
			}
			plans = plans.flatMap((plan) =>
				options.map((option) => [...plan, option]),
			);
		}
		return { plans, reasons: [] };
	}

	function quoteContext(
		request: BrokerRequest,
		placements: readonly PlacementDecision[],
		catalogHash: string,
		environmentDigest: string,
	): BrokerQuoteContext {
		const frozenRequest = Object.freeze({
			...request,
			scope: Object.freeze({ ...request.scope }),
			requirements: Object.freeze(
				request.requirements.map((requirement) =>
					Object.freeze({
						...requirement,
						features: Object.freeze([...requirement.features]),
					}),
				),
			),
		});
		const frozenPlacements = Object.freeze(
			placements.map((placement) => Object.freeze({ ...placement })),
		);
		const fields = {
			request: frozenRequest,
			placements: frozenPlacements,
			catalogHash,
			environmentDigest,
			policyHash,
			stationId,
			railHash,
		};
		const bindingDigest = `sha256:${createHash("sha256").update(JSON.stringify(fields)).digest("hex")}`;
		return Object.freeze({ ...fields, bindingDigest });
	}

	function sign(
		resolution: ResolutionReceipt | ResolutionRejection,
		events: BrokerEvent[],
	): ResolutionSignature | undefined {
		if (deps.signingKey === undefined) return undefined;
		const signature = signResolution(resolution, deps.signingKey);
		events.push(
			brokerEvent(BROKER_EVENTS.ResolutionSigned, {
				requestId: resolution.requestId,
				brokerId: policies.brokerId,
				algorithm: signature.algorithm,
				payloadDigest: signature.payloadDigest,
			}),
		);
		return signature;
	}

	function reject(
		request: BrokerRequest,
		reasons: readonly RejectionReason[],
		priorEvents: BrokerEvent[],
	): BrokerResolution {
		const rejection: ResolutionRejection = {
			schemaVersion: BROKER_SCHEMA_VERSION,
			requestId: request.requestId,
			brokerId: policies.brokerId,
			policyHash,
			reasons,
			stationId,
			railHash,
		};
		const events = [
			...priorEvents,
			brokerEvent(BROKER_EVENTS.Rejected, {
				requestId: request.requestId,
				brokerId: policies.brokerId,
				policyHash,
				reasons: reasons.map((reason) => ({ ...reason })),
			}),
		];
		const signature = sign(rejection, events);
		return {
			outcome: "rejected",
			rejection,
			...(signature !== undefined ? { signature } : undefined),
			events,
		};
	}

	const broker: HoboBroker = {
		brokerId: policies.brokerId,
		policyHash,
		async resolve(input) {
			const request = parseBrokerRequest(input);
			const events: BrokerEvent[] = [
				brokerEvent(BROKER_EVENTS.Requested, {
					requestId: request.requestId,
					brokerId: policies.brokerId,
					bindleId: request.scope.bindleId,
					requirementCount: request.requirements.length,
				}),
			];

			if (issuedResolutions.has(request.requestId)) {
				return reject(
					request,
					[
						{
							plane: "billing",
							code: "reservation-replay-requires-reconciliation",
							message:
								"this broker has already issued a receipt for this request",
						},
					],
					events,
				);
			}

			// Plane 0 — connector registry: required connector kinds must be
			// registered and enabled before the broker will act on their behalf.
			if (policies.requiredConnectorKinds.length > 0) {
				const missing = deps.connectors?.missingKinds(
					policies.requiredConnectorKinds,
				) ?? [...policies.requiredConnectorKinds];
				if (missing.length > 0) {
					return reject(
						request,
						missing.map((kind) => ({
							plane: "connectors" as const,
							code: "connector-missing",
							message: `required connector kind ${kind} is not registered and enabled`,
						})),
						events,
					);
				}
			}

			// Plane 0.5 — admin controls: the Broker Environment must be approved
			// and its pinned catalog snapshot must match the live catalog.
			if (deps.environment !== undefined) {
				if (!deps.environment.approved) {
					return reject(
						request,
						[
							{
								plane: "policy",
								code: "environment-unapproved",
								message: `broker environment ${deps.environment.environmentId} is published but not approved`,
							},
						],
						events,
					);
				}
				if (
					deps.environment.catalogHash !== undefined &&
					deps.environment.catalogHash !== deps.catalog.catalogHash
				) {
					return reject(
						request,
						[
							{
								plane: "policy",
								code: "catalog-snapshot-stale",
								message: `broker environment ${deps.environment.environmentId} pins catalog ${deps.environment.catalogHash} but the live catalog is ${deps.catalog.catalogHash}`,
							},
						],
						events,
					);
				}
			}

			// Placement policy selection: the broker only acts on configured
			// policy — no applicable placement policy means no placement.
			const effective = effectivePlacementPolicy(policies, request.scope);
			if (effective === undefined) {
				return reject(
					request,
					[
						{
							plane: "policy",
							code: "no-placement-policy",
							message: `no placement policy applies to scope bindle=${request.scope.bindleId}`,
						},
					],
					events,
				);
			}

			// Junction-governance lockdown: explicit Camps required.
			if (
				effective.requireExplicitCamps &&
				request.scope.campId === undefined
			) {
				return reject(
					request,
					[
						{
							plane: "policy",
							code: "explicit-camp-required",
							message:
								"placement is locked down to explicit, approved camps; the request names no camp",
						},
					],
					events,
				);
			}

			let placements: PlacementDecision[] | undefined;
			let authorizedEstimate = request.spendEstimateUsd;
			let requestDigest = JSON.stringify(request);
			let quoteHash: string | undefined;
			let bindingDigest: string | undefined;
			let selectedQuote: QuoteVector | undefined;
			let selectedContext: BrokerQuoteContext | undefined;
			const catalogHash = deps.catalog.catalogHash;
			const environmentSnapshot = JSON.stringify(deps.environment ?? null);
			const environmentDigest = `sha256:${createHash("sha256").update(environmentSnapshot).digest("hex")}`;
			const environmentChanged = () =>
				JSON.stringify(deps.environment ?? null) !== environmentSnapshot;
			const rejectEnvironment = () =>
				reject(
					request,
					[
						{
							plane: "policy",
							code: "environment-stale",
							message: "broker environment changed during resolution",
						},
					],
					events,
				);
			const pricing = deps.pricingAuthority;
			const pricingChanged = () => deps.pricingAuthority !== pricing;
			const rejectPricing = () =>
				reject(
					request,
					[
						{
							plane: "billing",
							code: "quote-authority-stale",
							message: "pricing authority changed during resolution",
						},
					],
					events,
				);
			const quotedCandidates: Array<{
				placements: PlacementDecision[];
				context: BrokerQuoteContext;
				quote: QuoteVector;
				amount: number;
				score: Decimal;
				key: string;
			}> = [];
			if (pricing) {
				const search = enumeratePlans(request, effective);
				if (pricingChanged()) return rejectPricing();
				if (search.reasons.length)
					return reject(request, search.reasons, events);
				if (environmentChanged()) return rejectEnvironment();
				if (deps.catalog.catalogHash !== catalogHash)
					return reject(
						request,
						[
							{
								plane: "policy",
								code: "catalog-snapshot-stale",
								message: "catalog changed during candidate enumeration",
							},
						],
						events,
					);
				let refused: RejectionReason[] | undefined;
				try {
					for (const candidate of search.plans) {
						const context = quoteContext(
							request,
							candidate,
							catalogHash,
							environmentDigest,
						);
						const suppliedQuote = await pricing.quote(context);
						if (pricingChanged()) return rejectPricing();
						if (!suppliedQuote)
							return reject(
								request,
								[
									{
										plane: "billing",
										code: "quote-authority-unavailable",
										message:
											"pricing authority returned no quote for a candidate plan",
									},
								],
								events,
							);
						const quote = clone(QuoteVectorSchema, suppliedQuote);
						const authorization = authorizeBillingSpend({
							quote,
							billing: policies.billing,
							attestQuote: (item) => pricing.attest(context, item),
						});
						if (pricingChanged()) return rejectPricing();
						if (deps.catalog.catalogHash !== catalogHash)
							return reject(
								request,
								[
									{
										plane: "policy",
										code: "catalog-snapshot-stale",
										message: "catalog changed during quote search",
									},
								],
								events,
							);
						if (environmentChanged()) return rejectEnvironment();
						if (!authorization.ok) {
							if (
								authorization.reasons.length > 0 &&
								authorization.reasons.every(
									(reason) =>
										reason.code === "budget-exceeded" ||
										reason.code === "spend-cap-exceeded",
								)
							) {
								refused ??= authorization.reasons;
								continue;
							}
							return reject(request, authorization.reasons, events);
						}
						const score = parseDecimal(
							quote.incremental?.billed?.decimal ?? "",
						);
						if (!score)
							return reject(
								request,
								[
									{
										plane: "billing",
										code: "quote-invalid",
										message: "candidate quote has no valid total",
									},
								],
								events,
							);
						const key = JSON.stringify(
							candidate.map((entry) => [
								entry.resourceId,
								entry.providerId,
								entry.definitionId,
								entry.region,
							]),
						);
						quotedCandidates.push({
							placements: candidate,
							context,
							quote,
							amount: authorization.authorizedUsd,
							score,
							key,
						});
					}
					if (quotedCandidates.length === 0)
						return reject(
							request,
							refused ?? [
								{
									plane: "billing",
									code: "quote-ineligible",
									message: "no eligible affordable quote",
								},
							],
							events,
						);
					quotedCandidates.sort(
						(a, b) =>
							compareDecimal(a.score, b.score) || compareIdentity(a.key, b.key),
					);
				} catch {
					return reject(
						request,
						[
							{
								plane: "billing",
								code: "quote-authority-unavailable",
								message: "pricing authority could not verify candidate plans",
							},
						],
						events,
					);
				}
			} else if (deps.trustLegacyEstimates !== true) {
				return reject(
					request,
					[
						{
							plane: "billing",
							code: "quote-authority-required",
							message: "configure a trusted pricing authority for this request",
						},
					],
					events,
				);
			}

			let candidateIndex = 0;
			for (;;) {
				if (pricingChanged()) return rejectPricing();
				if (pricing) {
					const candidate = quotedCandidates[candidateIndex++];
					if (!candidate) throw new Error("candidate search exhausted");
					placements = candidate.placements;
					authorizedEstimate = candidate.amount;
					quoteHash = candidate.quote.quoteHash;
					selectedQuote = candidate.quote;
					selectedContext = candidate.context;
					bindingDigest = candidate.context.bindingDigest;
					requestDigest = JSON.stringify({
						bindingDigest,
						quoteHash,
						authorizedEstimate,
					});
				}
				if (environmentChanged()) return rejectEnvironment();
				if (pricing && deps.catalog.catalogHash !== catalogHash)
					return reject(
						request,
						[
							{
								plane: "policy",
								code: "catalog-snapshot-stale",
								message: "catalog changed before policy evaluation",
							},
						],
						events,
					);

				// Plane 1 — the Gatekeeper composition (policy pack + contract
				// compatibility + obligations + quota), imported and RUN from
				// @hobo/contracts. Its policy.Decided / gatekeeper.Decided facts are
				// appended to this resolution's event list.
				const gate = await gatePlane.evaluate({
					request: toPolicyDecisionRequest(policies.brokerId, {
						...request,
						spendEstimateUsd: authorizedEstimate,
					}),
					costQuota: {
						quota: policies.billing.quota,
						used: policies.billing.quotaUsed,
						limit: policies.billing.quotaLimit,
					},
				});
				if (pricingChanged()) return rejectPricing();
				for (const gateEvent of gate.events) {
					events.push({
						type: String(gateEvent.type ?? "gatekeeper.Event"),
						data: gateEvent,
					});
				}
				if (gate.effect === "deny" || gate.effect === "require-approval") {
					const reasons: RejectionReason[] =
						gate.reasons.length > 0
							? gate.reasons
							: [
									{
										plane: "policy",
										code: "approval-required",
										message:
											"the gate plane requires approval before placement",
									},
								];
					return reject(request, reasons, events);
				}

				if (environmentChanged()) return rejectEnvironment();

				// The gate can await external policy. Recheck evidence and the catalog
				// before creating a hold; the authority must refuse expired evidence.
				if (pricing && selectedQuote && selectedContext) {
					const context = selectedContext;
					if (deps.catalog.catalogHash !== catalogHash)
						return reject(
							request,
							[
								{
									plane: "policy",
									code: "catalog-snapshot-stale",
									message: "catalog changed before billing admission",
								},
							],
							events,
						);
					const checked = authorizeBillingSpend({
						quote: selectedQuote,
						billing: policies.billing,
						attestQuote: (candidate) => pricing.attest(context, candidate),
					});
					if (pricingChanged()) return rejectPricing();
					if (!checked.ok) return reject(request, checked.reasons, events);
					if (checked.authorizedUsd !== authorizedEstimate)
						return reject(
							request,
							[
								{
									plane: "billing",
									code: "quote-authority-stale",
									message: "quote liability changed while policy was evaluated",
								},
							],
							events,
						);
				}

				// Attestation itself is host code, so check its side effects before
				// asking billing to create a hold.
				if (environmentChanged()) return rejectEnvironment();
				if (pricing && deps.catalog.catalogHash !== catalogHash)
					return reject(
						request,
						[
							{
								plane: "policy",
								code: "catalog-snapshot-stale",
								message: "catalog changed during final quote attestation",
							},
						],
						events,
					);

				// Plane 2 — billing enforcement beyond quota: budget + spend cap.
				const billing = billingPlane.authorize({
					spendEstimateUsd: authorizedEstimate,
					billing: { ...policies.billing },
					requestId: request.requestId,
					requestDigest,
				});
				if (pricingChanged()) {
					if (billing.ok && billing.reservationCreated === true)
						billingPlane.release?.(request.requestId, true);
					return rejectPricing();
				}
				if (!billing.ok) {
					if (
						pricing &&
						candidateIndex < quotedCandidates.length &&
						billing.noReservationCreated === true &&
						billing.reservationCreated !== true &&
						billing.reasons.length > 0 &&
						billing.reasons.every(
							(reason) =>
								reason.code === "budget-exceeded" ||
								reason.code === "spend-cap-exceeded",
						)
					) {
						events.push(
							brokerEvent(BROKER_EVENTS.CandidateUnaffordable, {
								requestId: request.requestId,
								quoteHash: quoteHash ?? "",
								bindingDigest: bindingDigest ?? "",
								authorizedUsd: authorizedEstimate,
								reasons: billing.reasons.map((reason) => ({ ...reason })),
							}),
						);
						continue;
					}
					return reject(
						request,
						billing.reasons.length > 0
							? billing.reasons
							: [
									{
										plane: "billing",
										code: "billing-denied",
										message: "billing denied admission without a reason",
									},
								],
						events,
					);
				}
				if (pricing && billing.reservationCreated === undefined) {
					return reject(
						request,
						[
							{
								plane: "billing",
								code: "reservation-evidence-required",
								message:
									"billing did not confirm creation of a new reservation",
							},
						],
						events,
					);
				}
				if (billing.reservationCreated === false) {
					return reject(
						request,
						[
							{
								plane: "billing",
								code: "reservation-replay-requires-reconciliation",
								message:
									"this reservation was already authorized; reconcile the prior resolution",
							},
						],
						events,
					);
				}

				if (environmentChanged()) {
					if (billing.reservationCreated === true)
						billingPlane.release?.(request.requestId, true);
					return rejectEnvironment();
				}
				if (pricing && deps.catalog.catalogHash !== catalogHash) {
					if (billing.reservationCreated === true)
						billingPlane.release?.(request.requestId, true);
					return reject(
						request,
						[
							{
								plane: "policy",
								code: "catalog-snapshot-stale",
								message: "catalog changed while the hold was created",
							},
						],
						events,
					);
				}

				// Billing is synchronous but host code can take time or change its
				// evidence. Revalidate before a receipt can authorize effects.
				if (pricing && selectedQuote && selectedContext) {
					const context = selectedContext;
					const checked = authorizeBillingSpend({
						quote: selectedQuote,
						billing: policies.billing,
						attestQuote: (candidate) => pricing.attest(context, candidate),
					});
					if (pricingChanged()) {
						if (billing.reservationCreated === true)
							billingPlane.release?.(request.requestId, true);
						return rejectPricing();
					}
					if (!checked.ok || checked.authorizedUsd !== authorizedEstimate) {
						if (billing.reservationCreated === true)
							billingPlane.release?.(request.requestId, true);
						return reject(
							request,
							checked.ok
								? [
										{
											plane: "billing",
											code: "quote-authority-stale",
											message:
												"quote liability changed while the hold was created",
										},
									]
								: checked.reasons,
							events,
						);
					}
					if (
						environmentChanged() ||
						deps.catalog.catalogHash !== catalogHash
					) {
						if (billing.reservationCreated === true)
							billingPlane.release?.(request.requestId, true);
						if (environmentChanged()) return rejectEnvironment();
						return reject(
							request,
							[
								{
									plane: "policy",
									code: "catalog-snapshot-stale",
									message: "catalog changed during final quote check",
								},
							],
							events,
						);
					}
				}

				// Legacy estimate mode retains its prior placement order. The quoted
				// path already pinned these placements before authorizing the liability.
				if (!placements) {
					const plan = selectPlacements(request, effective);
					if (plan.reasons.length) {
						if (billing.reservationCreated === true)
							billingPlane.release?.(request.requestId, true);
						return reject(request, plan.reasons, events);
					}
					placements = plan.placements;
				}
				if (pricingChanged()) {
					if (billing.reservationCreated === true)
						billingPlane.release?.(request.requestId, true);
					return rejectPricing();
				}

				const receipt: ResolutionReceipt = {
					schemaVersion: BROKER_SCHEMA_VERSION,
					requestId: request.requestId,
					brokerId: policies.brokerId,
					catalogHash,
					policyHash,
					placementPolicyId: effective.id,
					placements,
					stationId,
					railHash,
					...(quoteHash && bindingDigest
						? {
								quoteHash,
								pricingBindingDigest: bindingDigest,
								authorizedUsd: authorizedEstimate,
							}
						: undefined),
				};
				events.push(
					brokerEvent(BROKER_EVENTS.Resolved, {
						requestId: request.requestId,
						brokerId: policies.brokerId,
						catalogHash,
						policyHash,
						placementPolicyId: effective.id,
						placements: placements.map((placement) => ({ ...placement })),
						...(quoteHash && bindingDigest
							? { quoteHash, bindingDigest, authorizedUsd: authorizedEstimate }
							: undefined),
					}),
				);
				const signature = sign(receipt, events);
				issuedResolutions.set(request.requestId, {
					canonical: canonicalResolutionJson(receipt),
					receipt: structuredClone(receipt),
					catalogHash,
					environmentSnapshot,
					...(pricing && selectedQuote && selectedContext
						? {
								pricing: {
									authority: pricing,
									quote: selectedQuote,
									context: selectedContext,
									amount: authorizedEstimate,
								},
							}
						: undefined),
					state: "ready",
				});
				return {
					outcome: "resolved",
					receipt,
					...(signature !== undefined ? { signature } : undefined),
					events,
				};
			}
		},
		scale(input) {
			const directive = parseScaleDirective(input);
			return {
				directive,
				events: [
					brokerEvent(BROKER_EVENTS.ScaleRequested, {
						brokerId: policies.brokerId,
						resourceId: directive.resourceId,
						direction: directive.direction,
						replicas: directive.replicas,
					}),
				],
			};
		},
		async deliver(receipt) {
			const issued = issuedResolutions.get(receipt.requestId);
			if (!issued || canonicalResolutionJson(receipt) !== issued.canonical) {
				throw new BrokerParseError(
					"delivery-receipt-untrusted",
					"delivery-receipt-untrusted: receipt was not issued by this broker instance",
				);
			}
			if (issued.state !== "ready") {
				throw new BrokerParseError(
					"delivery-already-claimed",
					"delivery-already-claimed: reconcile the previous delivery attempt",
				);
			}
			// Claim before host callbacks, which can reenter delivery. A failure
			// before dispatch is retryable; after dispatch it is uncertain.
			issued.state = "claimed";
			let snapshot: ResolutionReceipt;
			try {
				const currentEnvironment = () =>
					JSON.stringify(deps.environment ?? null) ===
					issued.environmentSnapshot;
				if (
					!currentEnvironment() ||
					deps.catalog.catalogHash !== issued.catalogHash
				) {
					throw new BrokerParseError(
						"delivery-context-stale",
						"delivery-context-stale: environment or catalog changed",
					);
				}
				if (issued.pricing) {
					const { authority, quote, context, amount } = issued.pricing;
					if (deps.pricingAuthority !== authority)
						throw new BrokerParseError(
							"delivery-quote-stale",
							"delivery-quote-stale: pricing authority changed",
						);
					const check = authorizeBillingSpend({
						quote,
						billing: policies.billing,
						attestQuote: (candidate) => authority.attest(context, candidate),
					});
					if (!check.ok || check.authorizedUsd !== amount)
						throw new BrokerParseError(
							"delivery-quote-stale",
							"delivery-quote-stale: quote or liability is no longer current",
						);
					if (deps.pricingAuthority !== authority)
						throw new BrokerParseError(
							"delivery-quote-stale",
							"delivery-quote-stale: pricing authority changed during quote check",
						);
					if (
						!currentEnvironment() ||
						deps.catalog.catalogHash !== issued.catalogHash
					)
						throw new BrokerParseError(
							"delivery-context-stale",
							"delivery-context-stale: context changed during quote check",
						);
				}
				snapshot = structuredClone(issued.receipt);
			} catch (error) {
				issued.state = "ready";
				throw error;
			}
			const ticket = await deliveryPlane.submit(
				snapshot,
				structuredClone(policies.delivery),
			);
			return {
				ticket,
				events: [
					brokerEvent(
						BROKER_EVENTS.DeliverySubmitted,
						deliverySubmittedBody({
							requestId: issued.receipt.requestId,
							brokerId: policies.brokerId,
							ticket,
						}),
					),
				],
			};
		},
	};
	return {
		...broker,
		async resolve(input) {
			const snapshot = cloneAsJson(input);
			const request = parseBrokerRequest(snapshot);
			if (resolvingRequests.has(request.requestId)) {
				return reject(
					request,
					[
						{
							plane: "billing",
							code: "reservation-replay-requires-reconciliation",
							message: "resolution for this request is already in progress",
						},
					],
					[
						brokerEvent(BROKER_EVENTS.Requested, {
							requestId: request.requestId,
							brokerId: policies.brokerId,
							bindleId: request.scope.bindleId,
							requirementCount: request.requirements.length,
						}),
					],
				);
			}
			resolvingRequests.add(request.requestId);
			try {
				return await broker.resolve(snapshot);
			} finally {
				resolvingRequests.delete(request.requestId);
			}
		},
	};
}

function placeRequirement(
	requirement: ResourceRequirement,
	definitions: readonly BrokerCatalogDefinition[],
	policy: EffectivePlacementPolicy,
	quoteAll: boolean,
): { placements: PlacementDecision[] } | { reason: RejectionReason } {
	let invalidDefinition = false;
	const selectedRegions = new Map<BrokerCatalogDefinition, string[]>();
	const eligible = definitions.filter((definition) => {
		if (
			policy.objective === "pinned" &&
			definition.providerId !== policy.pinnedProviderId
		)
			return false;
		if (policy.deniedProviders.includes(definition.providerId)) return false;
		if (
			policy.allowedProviders.length > 0 &&
			!policy.allowedProviders.includes(definition.providerId)
		)
			return false;
		try {
			const verdict = definition.satisfies({
				port: requirement.port,
				features: [...requirement.features],
			});
			if (verdict.kind !== "full") return false;
			const regions = eligibleRegions(requirement, definition, policy);
			if (regions.length === 0) return false;
			if (
				regions.some(
					(region) => !isJsonString(region) || region.trim().length === 0,
				)
			) {
				invalidDefinition = true;
				return false;
			}
			selectedRegions.set(definition, regions);
			return true;
		} catch {
			invalidDefinition = true;
			return false;
		}
	});

	if (invalidDefinition) {
		return {
			reason: {
				plane: "placement",
				code: "catalog-definition-invalid",
				message: "a catalog capability check failed",
			},
		};
	}
	if (eligible.length === 0) {
		return {
			reason: {
				plane: "placement",
				code: "no-eligible-provider",
				message: `no approved provider satisfies port ${requirement.port} for resource ${requirement.resourceId} under policy ${policy.id}`,
			},
		};
	}

	const candidates =
		policy.objective === "pinned"
			? eligible.filter(
					(definition) => definition.providerId === policy.pinnedProviderId,
				)
			: eligible;
	if (candidates.length === 0) {
		return {
			reason: {
				plane: "placement",
				code: "pinned-provider-unavailable",
				message: `pinned provider ${policy.pinnedProviderId ?? "<unset>"} cannot satisfy port ${requirement.port} for resource ${requirement.resourceId}`,
			},
		};
	}

	const ids = new Set<string>();
	const priced: Array<{
		definition: BrokerCatalogDefinition;
		price: Decimal;
		id: string;
		providerId: string;
		sku: string;
		unit: string;
		priceText: string;
	}> = [];
	let comparisonUnit: string | undefined;
	for (const definition of candidates) {
		let id: string,
			providerId: string,
			sku: string,
			unit: string,
			priceText: string;
		try {
			id = definition.id;
			providerId = definition.providerId;
			sku = definition.cost?.sku;
			unit = definition.cost?.unit;
			priceText = definition.cost?.marginalPrice;
		} catch {
			return {
				reason: {
					plane: "placement",
					code: "catalog-definition-invalid",
					message: "catalog definition fields could not be read",
				},
			};
		}
		if (
			!isJsonString(id) ||
			id.trim().length === 0 ||
			!isJsonString(providerId) ||
			providerId.trim().length === 0 ||
			!isJsonString(sku) ||
			sku.trim().length === 0
		) {
			return {
				reason: {
					plane: "placement",
					code: "catalog-definition-invalid",
					message:
						"eligible catalog definitions need a provider, identity and SKU",
				},
			};
		}
		if (ids.has(id)) {
			return {
				reason: {
					plane: "placement",
					code: "catalog-definition-conflict",
					message: "eligible catalog definitions must have distinct identities",
				},
			};
		}
		ids.add(id);
		let price: Decimal | undefined;
		try {
			price = isJsonString(priceText) ? parseDecimal(priceText) : undefined;
		} catch {
			price = undefined;
		}
		if (
			price === undefined ||
			price.coefficient < 0n ||
			!isJsonString(unit) ||
			unit.trim().length === 0
		) {
			return {
				reason: {
					plane: "placement",
					code: "catalog-price-invalid",
					message: `catalog price for ${id} must be a nonnegative decimal with a unit`,
				},
			};
		}
		if (!quoteAll && comparisonUnit !== undefined && unit !== comparisonUnit) {
			return {
				reason: {
					plane: "placement",
					code: "catalog-price-incomparable",
					message: "eligible catalog prices use different units",
				},
			};
		}
		comparisonUnit = unit;
		priced.push({ definition, price, id, providerId, sku, unit, priceText });
	}
	priced.sort(
		(a, b) =>
			compareDecimal(a.price, b.price) ||
			compareIdentity(a.providerId, b.providerId) ||
			compareIdentity(a.id, b.id),
	);
	if (priced.length === 0) {
		return {
			reason: {
				plane: "placement",
				code: "no-eligible-provider",
				message: "no priced catalog definition is eligible",
			},
		};
	}
	const placements: PlacementDecision[] = [];
	for (const selected of priced) {
		const winner = selected.definition;

		let regions: string[];
		try {
			regions = eligibleRegions(requirement, winner, policy);
		} catch {
			regions = [];
		}
		if (
			JSON.stringify(regions) !== JSON.stringify(selectedRegions.get(winner))
		) {
			return {
				reason: {
					plane: "placement",
					code: "catalog-definition-invalid",
					message: "selected catalog regions changed during placement",
				},
			};
		}

		try {
			if (
				winner.id !== selected.id ||
				winner.providerId !== selected.providerId ||
				winner.cost.sku !== selected.sku ||
				winner.cost.unit !== selected.unit ||
				winner.cost.marginalPrice !== selected.priceText
			) {
				return {
					reason: {
						plane: "placement",
						code: "catalog-definition-invalid",
						message: "selected catalog definition changed during placement",
					},
				};
			}
		} catch {
			return {
				reason: {
					plane: "placement",
					code: "catalog-definition-invalid",
					message: "selected catalog definition could not be rechecked",
				},
			};
		}
		for (const region of quoteAll ? regions : regions.slice(0, 1)) {
			placements.push({
				resourceId: requirement.resourceId,
				providerId: selected.providerId,
				definitionId: selected.id,
				region,
				sku: selected.sku,
				unit: selected.unit,
				marginalPrice: selected.priceText,
			});
		}
	}
	return { placements };
}

// Tie breaks use a stable code-unit order, independent of host locale.
function compareIdentity(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function eligibleRegions(
	requirement: ResourceRequirement,
	definition: BrokerCatalogDefinition,
	policy: EffectivePlacementPolicy,
): string[] {
	const allowed =
		policy.allowedRegions.length > 0
			? definition.regions.filter((region) =>
					policy.allowedRegions.includes(region),
				)
			: [...definition.regions];
	if (requirement.region !== undefined)
		return allowed.includes(requirement.region) ? [requirement.region] : [];
	return [...new Set(allowed)];
}

export function parseScaleDirective(
	input: JsonValue | undefined,
): ScaleDirective {
	if (input === null || !isJsonObject(input) || Array.isArray(input)) {
		throw new BrokerParseError(
			"invalid-scale-directive",
			"invalid-scale-directive: expected an object",
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	const raw = input as JsonObject;
	const resourceId = raw.resourceId ?? raw.resource_id;
	if (!isJsonString(resourceId) || resourceId.length === 0) {
		throw new BrokerParseError(
			"invalid-scale-directive",
			"invalid-scale-directive: resourceId must be a non-empty string",
		);
	}
	const direction = raw.direction;
	if (
		!isJsonString(direction) ||
		// SAFETY: assertion required at this I/O or test boundary.
		!SCALE_DIRECTIONS.includes(direction as ScaleDirection)
	) {
		throw new BrokerParseError(
			"invalid-scale-direction",
			`invalid-scale-direction: ${String(direction)} is not one of ${SCALE_DIRECTIONS.join("|")}`,
		);
	}
	const replicasRaw = raw.replicas;
	const replicas =
		isJsonNumber(replicasRaw) &&
		Number.isInteger(replicasRaw) &&
		replicasRaw >= 0
			? replicasRaw
			: direction === "zero"
				? 0
				: undefined;
	if (replicas === undefined) {
		throw new BrokerParseError(
			"invalid-scale-directive",
			"invalid-scale-directive: replicas must be an integer >= 0",
		);
	}
	// Dependent constraint (broker.cue): scale-to-zero means zero replicas.
	if (direction === "zero" && replicas !== 0) {
		throw new BrokerParseError(
			"invalid-scale-directive",
			"invalid-scale-directive: direction 'zero' requires replicas 0",
		);
	}
	// SAFETY: assertion required at this I/O or test boundary.
	return { resourceId, direction: direction as ScaleDirection, replicas };
}

// ---- Broker decision read model ----

export interface BrokerDecisionRow {
	requestId: string;
	outcome: "resolved" | "rejected";
	placementCount: number;
	reasonCodes: string[];
}

// Materialized view over the broker's decision facts: a pure fold, so the
// projection rebuilds from the event store from zero. Snapshot/restore below
// persist the current rows to a read store for cached current reads.
export function foldBrokerDecisions(
	events: Iterable<{ type: string; data?: unknown }>,
): BrokerDecisionRow[] {
	const rows = new Map<string, BrokerDecisionRow>();
	for (const event of events) {
		// SAFETY: assertion required at this I/O or test boundary.
		const data = (event.data ?? {}) as JsonObject;
		const requestId = data.requestId;
		if (!isJsonString(requestId) || requestId.length === 0) continue;
		if (event.type === BROKER_EVENTS.Resolved) {
			const placements = Array.isArray(data.placements) ? data.placements : [];
			rows.set(requestId, {
				requestId,
				outcome: "resolved",
				placementCount: placements.length,
				reasonCodes: [],
			});
		} else if (event.type === BROKER_EVENTS.Rejected) {
			const reasons = Array.isArray(data.reasons) ? data.reasons : [];
			rows.set(requestId, {
				requestId,
				outcome: "rejected",
				placementCount: 0,
				reasonCodes: reasons
					.map((reason) =>
						isJsonObject(reason) && isJsonString(reason.code)
							? reason.code
							: "",
					)
					.filter((code) => code.length > 0),
			});
		}
	}
	return [...rows.values()];
}

export function snapshotBrokerDecisions(rows: BrokerDecisionRow[]): string {
	return JSON.stringify({ schemaVersion: BROKER_SCHEMA_VERSION, rows });
}

export function restoreBrokerDecisions(snapshot: string): BrokerDecisionRow[] {
	// SAFETY: assertion required at this I/O or test boundary.
	const parsed = JSON.parse(snapshot) as {
		schemaVersion?: string;
		rows?: BrokerDecisionRow[];
	};
	if (parsed.schemaVersion !== BROKER_SCHEMA_VERSION) {
		throw new BrokerParseError(
			"unsupported-snapshot",
			`unsupported-snapshot: ${String(parsed.schemaVersion)} is not ${BROKER_SCHEMA_VERSION}`,
		);
	}
	return parsed.rows ?? [];
}
