package data_models

import "list"

#BudgetIdentity: {
	tenantId:       string & !=""
	budgetId:       string & !=""
	periodId:       string & !=""
	policyRevision: string & !=""
}
#Micros: int & >=0 & <=9007199254740991
#IacSha256: string & =~"^sha256:[a-f0-9]{64}$"
#EntitlementKind: "allowance" | "credit" | "commitment"
#BudgetLedgerSnapshot: {
	identity:       #BudgetIdentity
	seq:            int & >=0 & <=4294967295
	limitMicros:    #Micros
	spentMicros:    #Micros
	reservedMicros: #Micros
	observedAt:     string & !=""
	validUntil:     string & !=""
	providerAccounts?: [...#BudgetProviderAccount]
	entitlements?: [...#BudgetEntitlement]
	unresolvedMicros?:        #Micros
	recoveryReserveMicros?:   #Micros
	externalCommittedMicros?: #Micros
}
#BudgetProviderAccount: {providerAccountId: string & !="", limitMicros: #Micros, spentMicros: #Micros, reservedMicros: #Micros, externalCommittedMicros?: #Micros}
#BudgetEntitlement: {bucketId: string & !="", unit: string & !="", periodId: string & !="", remainingUnits: #Micros, reservedUnits: #Micros, observedAt: string & !="", validUntil: string & !=""}
#ProviderAccountExposure: {providerAccountId: string & !="", liabilityMicros: #Micros}
#EntitlementClaim: {
	bucketId: string & !=""
	unit:     string & !=""
	units:    #Micros
	kind:     #EntitlementKind
}
#HostingQuoteComponent: {name: string & !="", costMicros: #Micros}
#HostingQuote: {
	quoteId:               string & !=""
	yardId:                string & !=""
	providerId:            string & !=""
	ownerTenantId:         string & !=""
	currency:              "USD"
	totalMicros:           #Micros
	liabilityBoundMicros?: #Micros & >=totalMicros
	observedAt:            string & !=""
	validUntil:            string & !=""
	requestDigest:         string & !=""
	components: [#HostingQuoteComponent, ...#HostingQuoteComponent]
	totalMicros: list.Sum([for component in components {component.costMicros}])
	providerAccounts?: [...#ProviderAccountExposure]
	entitlementClaims?: [...#EntitlementClaim]
	financialPlanHash?: string
}
#BudgetReservation: {
	reservationId: string & !=""
	identity: #BudgetIdentity
	requestDigest: string & !=""
	quoteId: string & !=""
	reservedMicros: #Micros
	status: "held" | "uncertain" | "settled" | "released"
	actualMicros: #Micros
	ledgerSeq: int & >=0
	quoteDigest: string & !=""
	providerAccounts?: [...#ProviderAccountExposure]
	entitlementClaims?: [...#EntitlementClaim]
	usageEvidenceRef?: string
	sourceStoppedEvidenceRef?: string
	settlementEvidence?: #BudgetSettlementEvidence
	executionDigest?: string
	financialPlanHash?: string
	fenceSettlementGuard?: #BudgetFenceSettlementGuard
}
#BudgetSettlementEvidence: {usageEvidenceRef: string & !="", sourceStoppedEvidenceRef: string & !="", providerAccounts?: [...#ProviderAccountExposure], entitlementClaims?: [...#EntitlementClaim], fenceOperationReceiptJson?: string, financeSignature?: string}
#HostingPolicyProof: {requestDigest: string & !="", quoteId: string & !="", identity: #BudgetIdentity, policyHash: string & !="", effect: "allow" | "allow-degraded" | "deny" | "require-approval", evidenceRef: string & !="", obligationsSatisfied: bool}
#BudgetAuthorityEvent: {type: string & !="", snapshot: #BudgetLedgerSnapshot, reservations: [...#BudgetReservation], reconciliationEvidenceRef?: string}

#IacTargetLiabilityEvidence: {
	evidenceRef:   string & !=""
	targetId:      string & !=""
	tenantId:      string & !=""
	planDigest:    #IacSha256
	inventoryHash: #IacSha256
	modelHash:     #IacSha256
	quoteHash:     #IacSha256
	maximumMicros: #Micros
	observedAt:    string & !=""
	validUntil:    string & !=""
	providerAccounts: [#ProviderAccountExposure, ...#ProviderAccountExposure]
	maximumMicros: list.Sum([for account in providerAccounts {account.liabilityMicros}])
	_limit: true & (len(providerAccounts) <= 256)
	_unique: {
		for i, left in providerAccounts
		for j, right in providerAccounts
		if j > i {"\(i)/\(j)": true & (left.providerAccountId != right.providerAccountId)}
	}
}
#IacBudgetDisclosure: {
	evaluation:  "allowed" | "denied" | "unavailable"
	reservation: "not-created" | "held" | "uncertain" | "settled" | "released" | "unknown"
	if evaluation == "denied" {reservation: "not-created"}
	if evaluation == "allowed" {reservation: "held" | "settled" | "released"}
}
#IacAdmissionHold: {
	_requestID:    string & #IacSha256
	_quoteID:      string & !=""
	requestDigest: _requestID
	inventoryHash: #IacSha256
	modelHash:     #IacSha256
	quoteHash:     #IacSha256
	quote: {
		requestDigest:        _requestID
		yardId:               string & !=""
		ownerTenantId:        string & !=""
		financialPlanHash:    #IacSha256
		providerAccounts:     [#ProviderAccountExposure, ...#ProviderAccountExposure]
		entitlementClaims:    [...#EntitlementClaim]
		liabilityBoundMicros: list.Sum([for account in providerAccounts {account.liabilityMicros}])
	}
	reservation: {
		requestDigest:        _requestID
		quoteId:                _quoteID
		status:                 "held"
		reservedMicros:         quote.liabilityBoundMicros
		providerAccounts:       quote.providerAccounts
		entitlementClaims:      quote.entitlementClaims
		financialPlanHash:      quote.financialPlanHash
	}
	policyProof: {
		requestDigest:        _requestID
		quoteId:                _quoteID
		identity:               #BudgetIdentity
		effect:                 "allow" | "allow-degraded"
		obligationsSatisfied: true
	}
}
#IacTargetAdmissionDecision: {
	requestId:      string & !=""
	targetId:       string & !=""
	status:         "admitted" | "denied" | "replay" | "uncertain"
	code:           string
	message:        string
	budget:         #IacBudgetDisclosure
	requestDigest?: string
	inventoryHash?: string
	modelHash?:     string
	quoteHash?:     string
	quote?:         #HostingQuote
	reservation?:   #BudgetReservation
	policyProof?:   #HostingPolicyProof
	if status == "denied" {
		code: string & !=""
		budget: {evaluation: "denied" | "unavailable", reservation: "not-created"}
		quote?: _
		reservation?: _
		policyProof?: _
	}
	if status == "admitted" {
		code: string
		budget: {evaluation: "allowed", reservation: "held"}
		#IacAdmissionHold
		quote: {yardId: targetId}
	}
	if status == "replay" {
		code: "EXECUTION_ALREADY_CLAIMED"
		budget: {evaluation: "allowed", reservation: "held"}
		#IacAdmissionHold
		quote: {yardId: targetId}
	}
	if status == "uncertain" {
		code: string & !=""
		budget: {evaluation: "unavailable", reservation: "unknown" | "held" | "uncertain"}
		quote?: _
		policyProof?: _
		if budget.reservation == "held" {
			reservation: #BudgetReservation & {status: "held" | "uncertain"}
		}
		if budget.reservation != "held" {
			reservation?: _
		}
	}
}

// Fixture root for the provider-neutral admission boundary.
#Budget: {
	iacEvidence?: #IacTargetLiabilityEvidence
	iacDecision?: #IacTargetAdmissionDecision
	if iacDecision != _|_ && iacDecision.status == "admitted" {
		iacEvidence: #IacTargetLiabilityEvidence & {
			targetId:      iacDecision.targetId
			tenantId:      iacDecision.quote.ownerTenantId
			planDigest:    iacDecision.quote.financialPlanHash
			inventoryHash: iacDecision.inventoryHash
			modelHash:     iacDecision.modelHash
			quoteHash:     iacDecision.quoteHash
			maximumMicros: iacDecision.quote.liabilityBoundMicros
		}
	}
}