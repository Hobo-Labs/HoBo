/** Structural IaC port; its consumer owns the executor implementation. */
export interface IacProgram {
	programId: string;
	deploymentId: string;
	resourceId: string;
	provider: string;
	driver: string;
	action: "preview" | "apply" | "destroy";
	stackName: string;
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
	reservation?: { reservationId: string } | undefined;
	inventoryHash?: string;
	modelHash?: string;
	quoteHash?: string;
}

/** A successful apply has established a held reservation. */
export interface HeldFinancialDecision extends FinancialDecision {
	budget: { evaluation: "allowed"; reservation: "held" };
	reservation: { reservationId: string };
}

export interface FinancialExpectation {
	readonly targetId: string;
	readonly inventoryHash: string;
	readonly modelHash: string;
	readonly quoteHash: string;
}

/** The host supplies this port. The adapter never imports a policy implementation. */
export interface FinancialPort<Assessment extends object> {
	assess(plan: FinancialPlan): Assessment;
	admit(
		requestId: string,
		plan: FinancialPlan,
		expected?: FinancialExpectation,
	): Promise<FinancialDecision>;
	uncertain(reservationId: string): void | Promise<void>;
}
