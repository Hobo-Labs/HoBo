import { types } from "node:util";
import { clone, create, toJson } from "@bufbuild/protobuf";
import {
	assessTargetPricing,
	createTargetPricingInventory,
	hashTargetPricingInventory,
	isBoundedPricingInput,
	isExactProtoMessage,
	QuoteScenarioSchema,
	QuoteVectorSchema,
	stableHash,
	type TargetPricingInventoryInput,
	TargetPricingInventorySchema,
	type TargetPricingModelInput,
	type TargetPricingQuote,
	targetPricingModel,
	targetPricingUnavailable,
} from "@hobo/pricing";
import {
	IacTargetAdmissionDecisionSchema,
	IacUnpricedPolicyProofSchema,
	IacUnpricedScopeProofSchema,
} from "./_generated/yard_placement_pb.js";
import { BudgetIdentitySchema } from "./budget-authority.js";
import {
	admitIacTarget,
	type IacTargetAdmissionDeps,
	type IacTargetLiabilityEvidence,
} from "./iac-target.js";
import {
	admitUnpricedIacTarget,
	type IacUnpricedAuthorizer,
} from "./iac-unpriced.js";

const applyFinancialHost = Reflect.apply;
const hasOwnFinancialField = Object.hasOwn;
const isFinancialProxy = types.isProxy;

export type IacFinancialPlan = Omit<TargetPricingInventoryInput, "complete">;

export type IacFinancialExpectation =
	| {
			readonly kind?: "priced";
			readonly targetId: string;
			readonly inventoryHash: string;
			readonly modelHash: string;
			readonly quoteHash: string;
	  }
	| {
			readonly kind: "unpriced";
			readonly targetId: string;
			readonly inventoryHash: string;
	  };

export type IacAdmissionPath =
	| { readonly kind: "bounded-budget"; readonly budget: "evaluation-required" }
	| {
			readonly kind: "unpriced-policy";
			readonly budget: "bypassed-if-authorized";
	  }
	| { readonly kind: "unavailable"; readonly code: string };

export interface IacRevalidationReceipt {
	readonly requestId: string;
	readonly targetId: string;
	readonly status: string;
	readonly requestDigest?: string | undefined;
	readonly inventoryHash?: string | undefined;
	readonly modelHash?: string | undefined;
	readonly quoteHash?: string | undefined;
	readonly budget?:
		| {
				readonly evaluation: string;
				readonly reservation: string;
		  }
		| undefined;
	readonly reservation?:
		| {
				readonly reservationId: string;
				readonly unboundedExposure?: boolean;
				readonly unpricedScopeProof?:
					| {
							readonly identity?:
								| {
										readonly tenantId: string;
										readonly budgetId: string;
										readonly periodId: string;
										readonly policyRevision: string;
								  }
								| undefined;
							readonly providerAccountIds: readonly string[];
							readonly authorityRef: string;
							readonly evidenceRef: string;
							readonly ownershipEpoch: string;
							readonly observedAt: string;
							readonly exclusiveUntilSettled: boolean;
							readonly noSharedEntitlements: boolean;
							readonly signature: string;
					  }
					| undefined;
		  }
		| undefined;
	readonly unpricedPolicyProof?:
		| {
				readonly requestDigest: string;
				readonly inventoryHash: string;
				readonly identity?:
					| {
							readonly tenantId: string;
							readonly budgetId: string;
							readonly periodId: string;
							readonly policyRevision: string;
					  }
					| undefined;
				readonly policyHash: string;
				readonly effect: string;
				readonly evidenceRef: string;
				readonly obligationsSatisfied: boolean;
				readonly observedAt: string;
				readonly validUntil: string;
		  }
		| undefined;
}

export interface IacFinancialServicesOptions
	extends Omit<IacTargetAdmissionDeps, "authorize" | "verifyLiability"> {
	readonly pricing?: Omit<TargetPricingModelInput, "planDigest">;
	readonly destroyPricing?: Omit<TargetPricingModelInput, "planDigest">;
	readonly verifyLiability?: IacTargetAdmissionDeps["verifyLiability"];
	readonly authorize?: IacTargetAdmissionDeps["authorize"];
	readonly unpriced?: { readonly authorize: IacUnpricedAuthorizer };
	readonly issueLiability?: (input: {
		inventory: ReturnType<typeof createTargetPricingInventory>;
		priced: Extract<TargetPricingQuote, { ok: true }>;
	}) => IacTargetLiabilityEvidence | Promise<IacTargetLiabilityEvidence>;
}

/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters -- SAFETY: external request data is checked before it is copied or read. */
function validRequestName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 200 &&
		value.trim() === value &&
		!/[\p{Cc}]/u.test(value)
	);
}

function captureExpectation(
	input: unknown,
): IacFinancialExpectation | undefined {
	if (input === undefined) return undefined;
	if (
		typeof input !== "object" ||
		input === null ||
		isFinancialProxy(input) ||
		Array.isArray(input) ||
		!isBoundedPricingInput(input)
	)
		throw new TypeError("invalid financial expectation");
	const copy = structuredClone(input);
	const keys = Object.keys(copy);
	const kind = Object.getOwnPropertyDescriptor(copy, "kind")?.value;
	const targetId = Object.getOwnPropertyDescriptor(copy, "targetId")?.value;
	const inventoryHash = Object.getOwnPropertyDescriptor(
		copy,
		"inventoryHash",
	)?.value;
	const modelHash = Object.getOwnPropertyDescriptor(copy, "modelHash")?.value;
	const quoteHash = Object.getOwnPropertyDescriptor(copy, "quoteHash")?.value;
	if (!validRequestName(targetId) || typeof inventoryHash !== "string")
		throw new TypeError("invalid financial expectation");
	if (kind === "unpriced") {
		if (
			keys.length !== 3 ||
			keys.some((key) => !["kind", "targetId", "inventoryHash"].includes(key))
		)
			throw new TypeError("invalid financial expectation");
		return Object.freeze({ kind, targetId, inventoryHash });
	}
	if (
		(Object.hasOwn(copy, "kind") && kind !== "priced") ||
		keys.length !== (kind === "priced" ? 5 : 4) ||
		keys.some(
			(key) =>
				![
					"kind",
					"targetId",
					"inventoryHash",
					"modelHash",
					"quoteHash",
				].includes(key),
		) ||
		typeof modelHash !== "string" ||
		typeof quoteHash !== "string"
	)
		throw new TypeError("invalid financial expectation");
	const captured: IacFinancialExpectation = {
		targetId,
		inventoryHash,
		modelHash,
		quoteHash,
	};
	if (kind === "priced")
		Object.defineProperty(captured, "kind", {
			value: "priced",
			enumerable: true,
		});
	return Object.freeze(captured);
}

function freezeHostData<T>(value: T): T {
	if (typeof value === "object" && value !== null) {
		for (const child of Object.values(value)) freezeHostData(child);
		Object.freeze(value);
	}
	return value;
}
/* oxlint-enable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters */

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type -- SAFETY: receipt data is detached and bounded before these exact-schema checks. */
function typedProofRecord(
	value: unknown,
	typeName: string,
): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		return undefined;
	const copy: Record<string, unknown> = Object.assign(
		Object.create(null),
		value,
	);
	if (Object.hasOwn(copy, "$typeName") && copy.$typeName !== typeName)
		return undefined;
	copy.$typeName = typeName;
	return copy;
}

function exactUnpricedProofs(policy: unknown, scope: unknown): boolean {
	const policyRecord = typedProofRecord(
		policy,
		IacUnpricedPolicyProofSchema.typeName,
	);
	const scopeRecord = typedProofRecord(
		scope,
		IacUnpricedScopeProofSchema.typeName,
	);
	if (!policyRecord || !scopeRecord) return false;
	const policyIdentity = typedProofRecord(
		policyRecord.identity,
		BudgetIdentitySchema.typeName,
	);
	const scopeIdentity = typedProofRecord(
		scopeRecord.identity,
		BudgetIdentitySchema.typeName,
	);
	if (!policyIdentity || !scopeIdentity) return false;
	policyRecord.identity = policyIdentity;
	scopeRecord.identity = scopeIdentity;
	return (
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: exact-schema inspection checks the complete detached policy before normalization.
		isExactProtoMessage(IacUnpricedPolicyProofSchema, policyRecord as never) &&
		// oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- SAFETY: exact-schema inspection checks the complete detached scope before normalization.
		isExactProtoMessage(IacUnpricedScopeProofSchema, scopeRecord as never)
	);
}
/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type */

/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: configuration is checked before any reflection or callback. */
export function createIacFinancialServices(
	options: IacFinancialServicesOptions,
) {
	let rawPricing: IacFinancialServicesOptions["pricing"];
	let rawDestroyPricing: IacFinancialServicesOptions["destroyPricing"];
	type FinancialHostParts = {
		authority: IacFinancialServicesOptions["authority"];
		now: IacFinancialServicesOptions["now"];
		verifyLiability: IacFinancialServicesOptions["verifyLiability"];
		authorize: IacFinancialServicesOptions["authorize"];
		issueLiability: IacFinancialServicesOptions["issueLiability"];
	};
	let hostParts: FinancialHostParts;
	let unpricedAuthorize: IacUnpricedAuthorizer | undefined;
	try {
		if (
			typeof options !== "object" ||
			options === null ||
			isFinancialProxy(options) ||
			Array.isArray(options)
		)
			throw new Error("invalid options");
		const prototype = Object.getPrototypeOf(options);
		if (prototype !== Object.prototype && prototype !== null)
			throw new Error("invalid options prototype");
		const keys = Reflect.ownKeys(options);
		if (
			keys.some(
				(key) =>
					typeof key !== "string" ||
					![
						"authority",
						"now",
						"verifyLiability",
						"authorize",
						"issueLiability",
						"pricing",
						"destroyPricing",
						"unpriced",
					].includes(key),
			)
		)
			throw new Error("unknown financial configuration");
		const own = <Key extends keyof IacFinancialServicesOptions>(
			key: Key,
		): IacFinancialServicesOptions[Key] => {
			const field = Object.getOwnPropertyDescriptor(options, key);
			if (
				field === undefined ||
				!hasOwnFinancialField(field, "value") ||
				!field.enumerable
			)
				throw new Error("financial host fields must be own data");
			return field.value;
		};
		const authority = own("authority");
		const now = own("now");
		const optional = <Key extends keyof IacFinancialServicesOptions>(
			key: Key,
		): IacFinancialServicesOptions[Key] | undefined => {
			const field = Object.getOwnPropertyDescriptor(options, key);
			if (field === undefined) return undefined;
			if (!hasOwnFinancialField(field, "value") || !field.enumerable)
				throw new Error("financial host fields must be own data");
			return field.value;
		};
		const verifyLiability = optional("verifyLiability");
		const authorize = optional("authorize");
		const issueLiability = optional("issueLiability");
		if (
			typeof authority !== "object" ||
			authority === null ||
			isFinancialProxy(authority) ||
			Array.isArray(authority)
		)
			throw new Error("invalid financial authority");
		if (typeof now !== "function" || isFinancialProxy(now))
			throw new Error("invalid financial clock");
		for (const callback of [verifyLiability, authorize, issueLiability])
			if (
				callback !== undefined &&
				(typeof callback !== "function" || isFinancialProxy(callback))
			)
				throw new Error("invalid financial host callback");
		hostParts = { authority, now, verifyLiability, authorize, issueLiability };
		const unpriced = optional("unpriced");
		if (unpriced !== undefined) {
			if (
				typeof unpriced !== "object" ||
				unpriced === null ||
				isFinancialProxy(unpriced) ||
				Array.isArray(unpriced)
			)
				throw new Error("invalid unpriced authority");
			const keys = Reflect.ownKeys(unpriced);
			const field = Object.getOwnPropertyDescriptor(unpriced, "authorize");
			if (
				keys.length !== 1 ||
				keys[0] !== "authorize" ||
				field === undefined ||
				!hasOwnFinancialField(field, "value") ||
				!field.enumerable ||
				typeof field.value !== "function" ||
				isFinancialProxy(field.value)
			)
				throw new Error("invalid unpriced callback");
			unpricedAuthorize = field.value;
		}
		for (const key of ["pricing", "destroyPricing"] as const) {
			const field = Object.getOwnPropertyDescriptor(options, key);
			if (
				(field === undefined && key in options) ||
				(field !== undefined &&
					(!hasOwnFinancialField(field, "value") ||
						!field.enumerable ||
						field.value === undefined))
			)
				throw new Error("pricing must be own data");
			if (key === "pricing") rawPricing = field?.value;
			else rawDestroyPricing = field?.value;
		}
	} catch {
		throw new TypeError("invalid pricing configuration");
	}
	const capturePricing = (raw: IacFinancialServicesOptions["pricing"]) => {
		if (raw === undefined) return undefined;
		if (!isBoundedPricingInput(raw))
			throw new TypeError("invalid or unbounded pricing configuration");
		let stable: NonNullable<IacFinancialServicesOptions["pricing"]>;
		try {
			stable = structuredClone(raw);
		} catch {
			throw new TypeError("invalid pricing configuration");
		}
		if (Object.hasOwn(stable, "planDigest"))
			throw new TypeError("the target plan digest is supplied by admission");
		const prepared = targetPricingModel({
			...stable,
			planDigest: `sha256:${"0".repeat(64)}`,
		});
		if (prepared.state.case !== "model")
			throw new TypeError("invalid pricing configuration");
		const source = prepared.state.value;
		const scenario = source.scenario;
		if (scenario === undefined)
			throw new TypeError("invalid pricing configuration");
		const model: Omit<TargetPricingModelInput, "planDigest"> = {
			modelId: source.modelId,
			revision: source.revision,
			scenario,
			bindings: source.bindings.map((binding) => {
				if (binding.candidateIndex === undefined)
					throw new TypeError("invalid pricing binding");
				return {
					resourceId: binding.resourceId,
					candidateIndex: binding.candidateIndex,
				};
			}),
		};
		return { model, receiver: freezeHostData(stable) };
	};
	const deployPricing = capturePricing(rawPricing);
	const destroyPricing = capturePricing(rawDestroyPricing);
	const capturedHost: IacFinancialServicesOptions = {
		authority: hostParts.authority,
		now: () => applyFinancialHost(hostParts.now, financialHost, []),
	};
	if (hostParts.verifyLiability !== undefined) {
		const callback = hostParts.verifyLiability;
		Object.defineProperty(capturedHost, "verifyLiability", {
			value: (input: Parameters<typeof callback>[0]) =>
				applyFinancialHost(callback, financialHost, [input]),
			enumerable: true,
		});
	}
	if (hostParts.authorize !== undefined) {
		const callback = hostParts.authorize;
		Object.defineProperty(capturedHost, "authorize", {
			value: (input: Parameters<typeof callback>[0]) =>
				applyFinancialHost(callback, financialHost, [input]),
			enumerable: true,
		});
	}
	if (hostParts.issueLiability !== undefined) {
		const callback = hostParts.issueLiability;
		Object.defineProperty(capturedHost, "issueLiability", {
			value: (input: Parameters<typeof callback>[0]) =>
				applyFinancialHost(callback, financialHost, [input]),
			enumerable: true,
		});
	}
	if (unpricedAuthorize !== undefined) {
		const callback = unpricedAuthorize;
		type UnpricedHost = NonNullable<IacFinancialServicesOptions["unpriced"]>;
		const unpricedHost: UnpricedHost = {
			authorize: (input) => applyFinancialHost(callback, unpricedHost, [input]),
		};
		Object.freeze(unpricedHost);
		Object.defineProperty(capturedHost, "unpriced", {
			value: unpricedHost,
			enumerable: true,
		});
	}
	if (deployPricing !== undefined)
		Object.defineProperty(capturedHost, "pricing", {
			value: deployPricing.receiver,
			enumerable: true,
		});
	if (destroyPricing !== undefined)
		Object.defineProperty(capturedHost, "destroyPricing", {
			value: destroyPricing.receiver,
			enumerable: true,
		});
	const financialHost = Object.freeze(capturedHost);
	const assess = (plan: IacFinancialPlan) => {
		if (!isBoundedPricingInput(plan))
			throw new TypeError("invalid financial plan");
		let stable: IacFinancialPlan;
		try {
			stable = structuredClone(plan);
		} catch {
			throw new TypeError("invalid financial plan");
		}
		if (
			stable === null ||
			stable === undefined ||
			Object.hasOwn(stable, "complete")
		)
			throw new TypeError(
				"financial plans must not declare inventory completeness",
			);
		const inventory = createTargetPricingInventory({
			...stable,
			complete: true,
		});
		const model =
			inventory.operation === "destroy"
				? (destroyPricing?.model ?? deployPricing?.model)
				: deployPricing?.model;
		const pricing =
			model === undefined
				? targetPricingUnavailable(
						"no financial model was supplied for this target",
					)
				: targetPricingModel({
						...model,
						scenario: clone(QuoteScenarioSchema, model.scenario),
						bindings: model.bindings.map((binding) => ({ ...binding })),
						planDigest: inventory.planDigest,
					});
		const { quote, providerCoverage } = assessTargetPricing(inventory, pricing);
		let admissionPath: IacAdmissionPath;
		if (quote.ok) {
			admissionPath =
				hostParts.issueLiability !== undefined &&
				hostParts.authorize !== undefined &&
				hostParts.verifyLiability !== undefined
					? { kind: "bounded-budget", budget: "evaluation-required" }
					: { kind: "unavailable", code: "FINANCIAL_CONFIGURATION_INCOMPLETE" };
		} else if (
			quote.code === "PRICING_MODEL_UNAVAILABLE" &&
			unpricedAuthorize !== undefined
		) {
			admissionPath = {
				kind: "unpriced-policy",
				budget: "bypassed-if-authorized",
			};
		} else {
			admissionPath = { kind: "unavailable", code: quote.code };
		}
		return {
			inventory,
			inventoryHash: hashTargetPricingInventory(inventory),
			pricing,
			quote,
			providerCoverage,
			admissionPath,
			budget: {
				evaluation: "not-evaluated",
				reservation: "not-created",
			} as const,
		};
	};
	return {
		assess,
		async revalidate(
			rawAdmission: IacRevalidationReceipt,
			rawPlan: IacFinancialPlan,
		): Promise<boolean> {
			try {
				if (
					!isBoundedPricingInput(rawAdmission) ||
					!isBoundedPricingInput(rawPlan)
				)
					return false;
				const admission = structuredClone(rawAdmission);
				const plan = structuredClone(rawPlan);
				const assessment = assess(plan);
				const requestDigest = admission.requestDigest;
				const inventoryHash = assessment.inventoryHash;
				if (
					admission.status !== "admitted" ||
					admission.targetId !== plan.targetId ||
					admission.reservation?.reservationId !==
						`iac:${admission.requestId}` ||
					admission.budget?.reservation !== "held" ||
					requestDigest === undefined ||
					inventoryHash === undefined ||
					admission.inventoryHash !== inventoryHash ||
					!/^sha256:[a-f0-9]{64}$/u.test(requestDigest)
				)
					return false;
				if (admission.budget.evaluation === "bypassed") {
					if (
						admission.reservation.unboundedExposure !== true ||
						admission.reservation.unpricedScopeProof === undefined ||
						admission.unpricedPolicyProof === undefined ||
						!exactUnpricedProofs(
							admission.unpricedPolicyProof,
							admission.reservation.unpricedScopeProof,
						) ||
						assessment.quote.ok ||
						assessment.quote.code !== "PRICING_MODEL_UNAVAILABLE" ||
						(admission.modelHash !== undefined && admission.modelHash !== "") ||
						(admission.quoteHash !== undefined && admission.quoteHash !== "")
					)
						return false;
					return (
						(await financialHost.authority.revalidateUnbounded({
							reservationId: admission.reservation.reservationId,
							requestDigest,
							inventoryHash,
							policyProofHash: stableHash(
								toJson(
									IacUnpricedPolicyProofSchema,
									create(
										IacUnpricedPolicyProofSchema,
										admission.unpricedPolicyProof,
									),
									{ alwaysEmitImplicit: true },
								),
							),
							scopeProofHash: stableHash(
								toJson(
									IacUnpricedScopeProofSchema,
									create(IacUnpricedScopeProofSchema, {
										...admission.reservation.unpricedScopeProof,
										providerAccountIds: [
											...admission.reservation.unpricedScopeProof
												.providerAccountIds,
										],
									}),
									{ alwaysEmitImplicit: true },
								),
							),
							executionDigest: stableHash({
								kind: "iac-target-execution",
								requestDigest,
								planDigest: plan.planDigest,
							}),
							now: financialHost.now(),
						})) === true
					);
				}
				if (
					admission.budget.evaluation !== "allowed" ||
					admission.reservation.unboundedExposure === true ||
					!assessment.quote.ok ||
					admission.modelHash !== assessment.quote.modelHash ||
					admission.quoteHash !== assessment.quote.quote.quoteHash
				)
					return false;
				return (
					(await financialHost.authority.revalidatePriced({
						reservationId: admission.reservation.reservationId,
						requestId: admission.requestId,
						targetId: admission.targetId,
						tenantId: plan.tenantId,
						requestDigest,
						planDigest: plan.planDigest,
						inventoryHash,
						modelHash: assessment.quote.modelHash,
						quoteHash: assessment.quote.quote.quoteHash,
						now: financialHost.now(),
					})) === true
				);
			} catch {
				return false;
			}
		},
		async admit(
			requestId: string,
			plan: IacFinancialPlan,
			expected?: IacFinancialExpectation,
		) {
			const invalid = () =>
				create(IacTargetAdmissionDecisionSchema, {
					requestId: validRequestName(requestId) ? requestId : "",
					targetId: "",
					status: "denied",
					code: "REQUEST_INVALID",
					message: "a bounded financial request is required",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				});
			if (!validRequestName(requestId)) return invalid();
			let assessment: ReturnType<typeof assess>;
			let capturedExpected: IacFinancialExpectation | undefined;
			try {
				capturedExpected = captureExpectation(expected);
				assessment = assess(plan);
			} catch {
				return invalid();
			}
			if (!validRequestName(assessment.inventory.targetId)) return invalid();
			const mismatch =
				capturedExpected !== undefined &&
				(capturedExpected.targetId !== assessment.inventory.targetId ||
					(capturedExpected.kind === "unpriced"
						? assessment.quote.ok ||
							assessment.quote.code !== "PRICING_MODEL_UNAVAILABLE" ||
							capturedExpected.inventoryHash !== assessment.inventoryHash
						: !assessment.quote.ok ||
							capturedExpected.inventoryHash !==
								assessment.quote.inventoryHash ||
							capturedExpected.modelHash !== assessment.quote.modelHash ||
							capturedExpected.quoteHash !== assessment.quote.quote.quoteHash));
			if (mismatch) {
				return create(IacTargetAdmissionDecisionSchema, {
					requestId,
					targetId: assessment.inventory.targetId,
					status: "denied",
					code:
						capturedExpected?.kind === "unpriced"
							? "ROUTING_INVENTORY_CHANGED"
							: "ROUTING_QUOTE_CHANGED",
					message:
						"the target pricing or inventory no longer matches the reviewed assessment",
					budget: { evaluation: "unavailable", reservation: "not-created" },
				});
			}
			if (
				!assessment.quote.ok &&
				assessment.quote.code === "PRICING_MODEL_UNAVAILABLE" &&
				financialHost.unpriced !== undefined
			) {
				return admitUnpricedIacTarget(
					{
						requestId,
						inventory: assessment.inventory,
						pricing: assessment.pricing,
					},
					{
						authority: financialHost.authority,
						now: financialHost.now,
						authorizeUnpriced: financialHost.unpriced.authorize,
					},
				);
			}
			let evidence: IacTargetLiabilityEvidence | undefined;
			if (assessment.quote.ok) {
				if (
					financialHost.issueLiability === undefined ||
					financialHost.authorize === undefined ||
					financialHost.verifyLiability === undefined
				)
					return create(IacTargetAdmissionDecisionSchema, {
						requestId,
						targetId: assessment.inventory.targetId,
						status: "denied",
						code: "FINANCIAL_CONFIGURATION_INCOMPLETE",
						message:
							"priced admission requires liability and policy authorities",
						budget: { evaluation: "unavailable", reservation: "not-created" },
					});
				try {
					evidence = await financialHost.issueLiability({
						inventory: clone(
							TargetPricingInventorySchema,
							assessment.inventory,
						),
						priced: {
							...assessment.quote,
							quote: clone(QuoteVectorSchema, assessment.quote.quote),
						},
					});
				} catch {
					return create(IacTargetAdmissionDecisionSchema, {
						requestId,
						targetId: assessment.inventory.targetId,
						status: "denied",
						code: "LIABILITY_SERVICE_UNAVAILABLE",
						message: "liability evidence could not be issued",
						budget: { evaluation: "unavailable", reservation: "not-created" },
					});
				}
			}
			try {
				const admission = {
					requestId,
					inventory: assessment.inventory,
					pricing: assessment.pricing,
				};
				if (
					evidence === undefined ||
					financialHost.authorize === undefined ||
					financialHost.verifyLiability === undefined
				)
					return create(IacTargetAdmissionDecisionSchema, {
						requestId,
						targetId: assessment.inventory.targetId,
						status: "denied",
						code: assessment.quote.ok
							? "FINANCIAL_CONFIGURATION_INCOMPLETE"
							: assessment.quote.code,
						message: assessment.quote.ok
							? "priced admission requires liability and policy authorities"
							: assessment.quote.reason,
						budget: { evaluation: "unavailable", reservation: "not-created" },
					});
				return await admitIacTarget(
					{ ...admission, evidence },
					{
						authority: financialHost.authority,
						now: financialHost.now,
						authorize: financialHost.authorize,
						verifyLiability: financialHost.verifyLiability,
					},
				);
			} catch {
				return create(IacTargetAdmissionDecisionSchema, {
					requestId,
					targetId: assessment.inventory.targetId,
					status: "uncertain",
					code: "ADMISSION_OUTCOME_UNKNOWN",
					message: "admission outcome must be reconciled before retry",
					budget: { evaluation: "unavailable", reservation: "unknown" },
				});
			}
		},
		async uncertain(reservationId: string): Promise<void> {
			await financialHost.authority.uncertain(reservationId);
		},
	};
}
/* oxlint-enable anti-slop/no-runtime-typeof */
