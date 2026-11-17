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
	/** A host-issued durable operation generation, stable across retries. */
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
				unpricedScopeProof?: UnpricedScopeProof;
		  }
		| undefined;
	requestDigest?: string;
	inventoryHash?: string;
	modelHash?: string;
	quoteHash?: string;
	unpricedPolicyProof?: UnpricedPolicyProof;
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

/** An admitted apply explicitly distinguishes a bounded hold from a policy-authorized unbounded exposure. */
export type HeldFinancialDecision = FinancialDecision &
	(
		| {
				budget: { evaluation: "allowed"; reservation: "held" };
				reservation: { reservationId: string; unboundedExposure?: false };
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

/** The host supplies this port. The adapter never imports a policy implementation. */
export interface FinancialPort<Assessment extends object> {
	assess(plan: FinancialPlan): Assessment;
	admit(
		requestId: string,
		plan: FinancialPlan,
		expected?: FinancialExpectation,
	): Promise<FinancialDecision>;
	/** Recheck a claimed unpriced exposure against durable authority and trusted current policy. */
	revalidate(
		admission: FinancialDecision,
		plan: FinancialPlan,
	): boolean | Promise<boolean>;
	uncertain(reservationId: string): void | Promise<void>;
}
