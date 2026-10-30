package core

import "list"

#BudgetPolicyIdentifier: string & =~"^[^\\p{Cc}]{1,200}$"
#BudgetPolicyInteger:    int & >=0 & <=9007199254740991
#BudgetPolicyConstraintRecord: close({
	key:      string & =~"^[a-z][a-z0-9_-]*([.][a-z][a-z0-9_-]*)+$"
	workload: "*" | (string & =~"^[a-z][a-z0-9_.-]{0,79}$")
	unit:     string & =~"^[A-Za-z][A-Za-z0-9_.:/-]{0,79}$"
	maximum:  #BudgetPolicyInteger
	target?:  string & =~"^[^\\p{Cc}]{0,200}$"
})
#BudgetPolicyRecord: close({
	schemaVersion: "hobo.budget-policy/v1"
	tenantId:      #BudgetPolicyIdentifier
	budgetId:      #BudgetPolicyIdentifier
	periodId:      #BudgetPolicyIdentifier
	revision:      #BudgetPolicyIdentifier
	workloads: [string & =~"^[a-z][a-z0-9_.-]{0,79}$", ...string & =~"^[a-z][a-z0-9_.-]{0,79}$"]
	_workloadCount:    len(workloads) & <=32
	_uniqueWorkloads:  list.UniqueItems(workloads) & true
	currency:          "USD"
	limitMicros:       #BudgetPolicyInteger
	objective:         "min-cost" | "maximize-credits"
	enforcement:       "strict" | "conservative"
	periodKind:        "manual" | "fixed-window"
	periodStartsAtMs?: #BudgetPolicyInteger
	periodEndsAtMs?:   #BudgetPolicyInteger
	constraints?: [...#BudgetPolicyConstraintRecord]
	if constraints != _|_ {
		_constraintCount: len(constraints) & <=128
	}
	if periodKind == "fixed-window" {
		periodStartsAtMs: #BudgetPolicyInteger
		periodEndsAtMs:   #BudgetPolicyInteger & >periodStartsAtMs & <=8640000000000000
	}
	if periodKind == "manual" {
		periodStartsAtMs?: _|_
		periodEndsAtMs?:   _|_
	}
})
#BudgetScopeIdentityRecord: {
	tenantId: #BudgetPolicyIdentifier, budgetId:       #BudgetPolicyIdentifier
	periodId: #BudgetPolicyIdentifier, policyRevision: #BudgetPolicyIdentifier
}
#BudgetPolicyMeasurementRecord: {
	key:     string & !="", unit: string & !="", value: #BudgetPolicyInteger
	target?: string
}
#BudgetPolicyEvaluationContextRecord: {
	workload:       string & !=""
	tenantId:       #BudgetPolicyIdentifier, budgetId:       #BudgetPolicyIdentifier
	periodId:       #BudgetPolicyIdentifier, policyRevision: #BudgetPolicyIdentifier
	nowMs:          #BudgetPolicyInteger, costBoundMicros:   #BudgetPolicyInteger
	exposureMicros: #BudgetPolicyInteger
	boundKind:      "native" | "conservative"
	phase?:         "plan" | "admit"
	measurements?: [...#BudgetPolicyMeasurementRecord]
}
#BudgetPolicyEvaluationRecord: {
	ok:                   bool, code: string & !="", reason: string & !=""
	projectedMicros?:     #BudgetPolicyInteger
	remainingMicros?:     #BudgetPolicyInteger
	requiresNativeBound?: bool
}
