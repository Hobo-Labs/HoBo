package cloud

#HostingMoney: int & >=0 & <=9007199254740991
#HostingBudgetSnapshot: {
	budgetId: string & !=""
	tenantId: string & !=""
	scopeId: string & !=""
	periodId: string & !=""
	policyRevision: string & !=""
	ledgerSeq: #HostingMoney
	currency: =~"^[A-Z]{3}$"
	periodStartMs: #HostingMoney
	periodEndMs: #HostingMoney & >periodStartMs
	capMicros: #HostingMoney
	settledMicros: #HostingMoney
	committedMicros: #HostingMoney
	unresolvedMicros: #HostingMoney
	recoveryReserveMicros: #HostingMoney
	observedAtMs: #HostingMoney
	validUntilMs: #HostingMoney & >observedAtMs
	providerAccountId?: string
	periodKind?: string & !=""
}
#HostingUsageBound: {
	resourceName: string & !=""
	unit: string & !=""
	expectedQuantity: number & >=0
	boundedQuantity: number & >=expectedQuantity
}
#HostingPriceQuote: {
	id: string & !=""
	resourceName: string & !=""
	definitionId: string & !=""
	providerId: string & !=""
	providerAccountId: string & !=""
	currency: =~"^[A-Z]{3}$"
	rateMicros: #HostingMoney
	billingUnit: string & !=""
	billingPeriodMs: #HostingMoney
	minimumQuantity: number & >=0
	roundUpQuantity: bool
	source: string & !=""
	observedAtMs: #HostingMoney
	validUntilMs: #HostingMoney & >observedAtMs
	liabilityEndsAtMs: #HostingMoney
	fixedCostMicros: #HostingMoney
	entitlementId?: string
	transitionCostMicros: #HostingMoney
	components?: [...#HostingChargeComponent]
}
#HostingChargeComponent: {
	id: string & !=""
	providerAccountId: string & !=""
	costClass: string & !=""
	expectedMicros: #HostingMoney
	boundedMicros: #HostingMoney & >=expectedMicros
	entitlementId?: string
}
#HostingProviderCharge: {
	providerAccountId: string & !=""
	expectedMicros: #HostingMoney
	reservedMicros: #HostingMoney & >=expectedMicros
}
#HostingEntitlementClaim: {
	entitlementId: string & !=""
	unit: string & !=""
	quantity: number & >=0
	costClass: string & !=""
}
#HostingEntitlement: {
	id: string & !=""
	providerAccountId: string & !=""
	currency: =~"^[A-Z]{3}$"
	unit: string & !=""
	remainingQuantity: number & >=0
	validUntilMs: #HostingMoney
	definitionIds: [...string]
	costClasses?: [...string & !=""]
	periodId: string & !=""
}
#HostingPlanningInput: {
	budget: #HostingBudgetSnapshot
	nowMs: #HostingMoney
	horizonEndMs: #HostingMoney & >nowMs & <=budget.periodEndMs
	maxObservationAgeMs: #HostingMoney
	quotes: [...#HostingPriceQuote]
	usages: [...#HostingUsageBound]
	entitlements: [...#HostingEntitlement]
	providerBudgets: [...#HostingBudgetSnapshot]
	// Struct contents additionally pass core #BudgetPolicyRecord and parseBudgetPolicy.
	budgetPolicy?: {...}
}
#HostingResourceCommitment: {
	resourceName: string & !=""
	definitionId: string & !=""
	quoteId: string & !=""
	providerAccountId: string & !=""
	entitlementId: string
	expectedMicros: #HostingMoney
	reservedMicros: #HostingMoney & >=expectedMicros
	reservedEntitlementQuantity: number & >=0
	providerCharges: [...#HostingProviderCharge]
	entitlementClaims: [...#HostingEntitlementClaim]
}
#HostingPlanCommitment: {
	budgetId: string & !=""
	tenantId: string & !=""
	scopeId: string & !=""
	periodId: string & !=""
	policyRevision: string & !=""
	ledgerSeq: #HostingMoney
	currency: =~"^[A-Z]{3}$"
	expectedMicros: #HostingMoney
	reservedMicros: #HostingMoney & >=expectedMicros
	validUntilMs: #HostingMoney
	allocations: [...#HostingResourceCommitment]
	commitmentHash: =~"^sha256:[a-f0-9]{64}$"
	evidence: #HostingPlanningInput
}
