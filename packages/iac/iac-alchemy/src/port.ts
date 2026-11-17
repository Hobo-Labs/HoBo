/** Structural IaC port; its consumer owns the executor implementation. */
export interface IacProgram {
	programId: string;
	deploymentId: string;
	resourceId: string;
	provider: string;
	driver: string;
	action: "preview" | "apply" | "destroy";
	stackName: string;
	/** The host declaration to authenticate against the configured stack, when supplied. */
	resource?: object | undefined;
	/** Host-issued generation persisted before apply or destroy and stable across retries. */
	operationGeneration?: string | undefined;
}

export interface IacDiff {
	summary: string;
	changes: number;
}
export interface IacDriftReport {
	drift: boolean;
	observed: Record<string, string>;
}
export interface IacProvider {
	readonly id: string;
	preview(program: IacProgram): Promise<IacDiff>;
	apply(program: IacProgram): Promise<Record<string, string>>;
	destroy(program: IacProgram): Promise<void>;
	refresh(program: IacProgram): Promise<IacDriftReport>;
}

export interface FinancialPlan {
	readonly targetId: string;
	readonly tenantId: string;
	readonly planDigest: string;
	readonly operation: "deploy" | "destroy";
	readonly evidenceRef: string;
	readonly resources: readonly {
		resourceId: string;
		providerId: string;
		providerAccountRef: string;
		productId: string;
	}[];
}

export interface FinancialDecision {
	requestId: string;
	targetId: string;
	status: string;
	code: string;
	message: string;
	budget?: { evaluation: string; reservation: string } | undefined;
	reservation?:
		| {
				reservationId: string;
				unboundedExposure?: boolean;
				unpricedScopeProof?: UnverifiedUnpricedScopeProof | undefined;
		  }
		| undefined;
	requestDigest?: string;
	inventoryHash?: string;
	modelHash?: string;
	quoteHash?: string;
	unpricedPolicyProof?: UnverifiedUnpricedPolicyProof | undefined;
}

export interface UnpricedPolicyProof {
	readonly requestDigest: string;
	readonly inventoryHash: string;
	readonly identity: {
		readonly tenantId: string;
		readonly budgetId: string;
		readonly periodId: string;
		readonly policyRevision: string;
	};
	readonly policyHash: string;
	readonly effect: "allow" | "allow-degraded";
	readonly evidenceRef: string;
	readonly obligationsSatisfied: true;
	readonly observedAt: string;
	readonly validUntil: string;
}

export interface UnpricedScopeProof {
	readonly identity: UnpricedPolicyProof["identity"];
	readonly providerAccountIds: readonly string[];
	readonly authorityRef: string;
	readonly evidenceRef: string;
	readonly ownershipEpoch: string;
	readonly observedAt: string;
	readonly exclusiveUntilSettled: true;
	readonly noSharedEntitlements: true;
	readonly signature: string;
}

/** Wire values are checked before they can become a held admission. */
export type UnverifiedUnpricedPolicyProof = Omit<
	UnpricedPolicyProof,
	"identity" | "effect" | "obligationsSatisfied"
> & {
	readonly identity?: UnpricedPolicyProof["identity"] | undefined;
	readonly effect: string;
	readonly obligationsSatisfied: boolean;
};

export type UnverifiedUnpricedScopeProof = Omit<
	UnpricedScopeProof,
	"identity" | "exclusiveUntilSettled" | "noSharedEntitlements"
> & {
	readonly identity?: UnpricedPolicyProof["identity"] | undefined;
	readonly exclusiveUntilSettled: boolean;
	readonly noSharedEntitlements: boolean;
};

/** An admitted apply explicitly distinguishes a bounded hold from a policy-authorized unbounded exposure. */
export type HeldFinancialDecision = Omit<
	FinancialDecision,
	"budget" | "reservation" | "unpricedPolicyProof"
> &
	(
		| {
				budget: { evaluation: "allowed"; reservation: "held" };
				reservation: { reservationId: string; unboundedExposure?: false };
				unpricedPolicyProof?: never;
		  }
		| {
				budget: { evaluation: "bypassed"; reservation: "held" };
				reservation: {
					reservationId: string;
					unboundedExposure: true;
					unpricedScopeProof: UnpricedScopeProof;
				};
				unpricedPolicyProof: UnpricedPolicyProof;
		  }
	);

export type FinancialExpectation =
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

/** An opaque capability for one active target attempt, issued by a shared route authority. */
export interface IacRouteOperation {
	readonly operationId: string;
	readonly authorization: string;
}

/** Target-independent operation facts authenticated by a trusted host resolver. */
export interface IacRouteContext {
	readonly tenantId: string;
	readonly deploymentId: string;
	readonly programId: string;
	readonly resourceId: string;
	/** Opaque HoBo identity; the physical Alchemy state name is separate. */
	readonly logicalStackName: string;
	/** Binds the exact desired declaration, including explicit absence. */
	readonly declarationDigest: string;
	readonly operation: "deploy" | "destroy";
	readonly operationGeneration: string;
	readonly requestId?: string | undefined;
}

export interface IacRouteResolution {
	readonly requestId: string;
	readonly operation: IacRouteOperation;
}

export type IacRouteResolver = (
	context: IacRouteContext,
) => IacRouteResolution | Promise<IacRouteResolution>;

export interface IacRoutePermit {
	readonly tenantId: string;
	readonly requestId: string;
	readonly operationId: string;
	readonly targetId: string;
	readonly inventoryHash: string;
	readonly attemptId: string;
}

export interface IacRouteOutcome {
	readonly status: "selected" | "denied" | "uncertain" | "replay";
	readonly targetId?: string;
}

export interface IacDirectRouteAttempt {
	readonly permit: IacRoutePermit;
	/** Persist a verified no-effect denial before completing the route. */
	deny(): Promise<void>;
}

export type IacDirectRouteResult<T> =
	| { readonly status: "executed"; readonly value: T }
	| {
			readonly status: "uncertain" | "replay";
			readonly code: string;
			readonly targetId?: string;
	  };

/** Host-supplied route service shared by all targets for a tenant. */
export interface IacRoutePort {
	readonly persistence: "durable-cas";
	/** Atomically consume this attempt once across all adapter instances. */
	consumeAttempt(permit: IacRoutePermit): boolean | Promise<boolean>;
	verifyAttempt(permit: IacRoutePermit): boolean | Promise<boolean>;
	runDirect<T>(
		input: {
			readonly tenantId: string;
			readonly requestId: string;
			readonly operation: IacRouteOperation;
			readonly targetId: string;
			readonly plan: FinancialPlan;
		},
		run: (
			attempt: IacDirectRouteAttempt,
		) => Promise<{ readonly value: T; readonly outcome: IacRouteOutcome }>,
	): Promise<IacDirectRouteResult<T>>;
}

/** The host supplies this port. The adapter never imports a policy implementation. */
export interface FinancialPort<Assessment extends object> {
	assess(plan: FinancialPlan): Assessment;
	admit(
		requestId: string,
		plan: FinancialPlan,
		expected?: FinancialExpectation,
	): Promise<FinancialDecision>;
	/** Recheck the exact claimed exposure against durable authority and trusted current policy. */
	revalidate(
		admission: FinancialDecision,
		plan: FinancialPlan,
	): boolean | Promise<boolean>;
	uncertain(reservationId: string): void | Promise<void>;
}
