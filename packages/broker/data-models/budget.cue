package data_models

import (
	"list"
	"strconv"
)

#BudgetIdentity: {
	tenantId:       string & !=""
	budgetId:       string & !=""
	periodId:       string & !=""
	policyRevision: string & !=""
}
#Micros:          int & >=0 & <=9007199254740991
#ProtoJSONMicros: string & =~"^(0|[1-9][0-9]{0,15})$"
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
	unboundedExposureCount?:  int & >=0 & <=256
}
#BudgetProviderAccount: {providerAccountId: string & !="", limitMicros: #Micros, spentMicros: #Micros, reservedMicros: #Micros, externalCommittedMicros?: #Micros}
#BudgetEntitlement: {bucketId: string & !="", unit: string & !="", kind?: #EntitlementKind | "", periodId: string & !="", remainingUnits: #Micros, reservedUnits: #Micros, observedAt: string & !="", validUntil: string & !=""}
#ProviderAccountExposure: {providerAccountId: string & !="", liabilityMicros: #Micros}
#EntitlementClaim: {
	bucketId:   string & !=""
	unit:       string & !=""
	units:      #Micros
	kind?:      #EntitlementKind | ""
	_scopeKind: #EntitlementKind
	if kind == _|_ {_scopeKind: "allowance"}
	if kind != _|_ {
		if kind == "" {_scopeKind: "allowance"}
		if kind != "" {_scopeKind: kind}
	}
}
#UniqueEntitlementClaims: {
	claims: [...#EntitlementClaim]
	for i, left in claims
	for j, right in claims
	if j > i {
		"\(i)/\(j)": true & (left._scopeKind != right._scopeKind || left.bucketId != right.bucketId || left.unit != right.unit)
	}
}
#ProviderAccountRowsMatch: {
	left: [...#ProviderAccountExposure]
	right: [...#ProviderAccountExposure]
	_length: true & (len(left) == len(right))
	for i, row in left {
		"left/\(i)": true & list.Contains([for candidate in right {
			providerAccountId: candidate.providerAccountId
			liabilityMicros:   candidate.liabilityMicros
		}], {
			providerAccountId: row.providerAccountId
			liabilityMicros:   row.liabilityMicros
		})
	}
	for i, row in right {
		"right/\(i)": true & list.Contains([for candidate in left {
			providerAccountId: candidate.providerAccountId
			liabilityMicros:   candidate.liabilityMicros
		}], {
			providerAccountId: row.providerAccountId
			liabilityMicros:   row.liabilityMicros
		})
	}
}
#EntitlementClaimRowsMatch: {
	left: [...#EntitlementClaim]
	right: [...#EntitlementClaim]
	_length: true & (len(left) == len(right))
	for i, row in left {
		"left/\(i)": true & (len([for candidate in right if candidate._scopeKind == row._scopeKind && candidate.bucketId == row.bucketId && candidate.unit == row.unit && candidate.units == row.units {candidate}]) == len([for candidate in left if candidate._scopeKind == row._scopeKind && candidate.bucketId == row.bucketId && candidate.unit == row.unit && candidate.units == row.units {candidate}]))
	}
	for i, row in right {
		"right/\(i)": true & (len([for candidate in left if candidate._scopeKind == row._scopeKind && candidate.bucketId == row.bucketId && candidate.unit == row.unit && candidate.units == row.units {candidate}]) == len([for candidate in right if candidate._scopeKind == row._scopeKind && candidate.bucketId == row.bucketId && candidate.unit == row.unit && candidate.units == row.units {candidate}]))
	}
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
	if entitlementClaims != _|_ {
		_uniqueEntitlementClaims: #UniqueEntitlementClaims & {claims: entitlementClaims}
	}
	financialPlanHash?: string
}
#BudgetReservation: {
	reservationId:   string & !=""
	identity:        #BudgetIdentity
	requestDigest:   string & !=""
	quoteId?:        string
	reservedMicros?: #Micros
	status:          "held" | "uncertain" | "settled" | "released"
	actualMicros?:   #Micros
	ledgerSeq:       int & >=0
	quoteDigest:     string & !=""
	providerAccounts?: [...#ProviderAccountExposure]
	entitlementClaims?: [...#EntitlementClaim]
	if entitlementClaims != _|_ {
		_uniqueEntitlementClaims: #UniqueEntitlementClaims & {claims: entitlementClaims}
	}
	usageEvidenceRef?:              string
	sourceStoppedEvidenceRef?:      string
	settlementEvidence?:            #BudgetSettlementEvidence
	executionDigest?:               string
	financialPlanHash?:             string
	fenceSettlementGuard?:          #BudgetFenceSettlementGuard
	fenceSettlementPayloadVersion?: "v2"
	unboundedExposure?:             bool
	unpricedPolicyProof?:           #IacUnpricedPolicyProof
	unpricedScopeProof?:            #IacUnpricedScopeProof
	iacPricingPin?:                 #IacPricingPin
	if unboundedExposure == _|_ {quoteId: string & !="", reservedMicros: #Micros, actualMicros: #Micros}
	if unboundedExposure != _|_ {
		if unboundedExposure == false {quoteId: string & !="", reservedMicros: #Micros, actualMicros: #Micros}
		if unboundedExposure == true {quoteId?: "", reservedMicros?: 0, unpricedPolicyProof: #IacUnpricedPolicyProof, unpricedScopeProof: #IacUnpricedScopeProof}
	}
}
#BudgetSettlementEvidence: {
	usageEvidenceRef:         string & !=""
	sourceStoppedEvidenceRef: string & !=""
	providerAccounts?: [...#ProviderAccountExposure]
	entitlementClaims?: [...#EntitlementClaim]
	if entitlementClaims != _|_ {
		_uniqueEntitlementClaims: #UniqueEntitlementClaims & {claims: entitlementClaims}
	}
	fenceOperationReceiptJson?: string
	financeSignature?:          string
}
#HostingPolicyProof: {requestDigest: string & !="", quoteId: string & !="", identity: #BudgetIdentity, policyHash: string & !="", effect: "allow" | "allow-degraded" | "deny" | "require-approval", evidenceRef: string & !="", obligationsSatisfied: bool}
#IacUnpricedPolicyProof: {requestDigest: string & !="", inventoryHash: string & !="", identity: #BudgetIdentity, policyHash: string & !="", effect: "allow" | "allow-degraded" | "deny" | "require-approval", evidenceRef: string & !="", obligationsSatisfied: bool, observedAt: string & !="", validUntil: string & !=""}
#IacUnpricedScopeProof: {identity: #BudgetIdentity, providerAccountIds: [string & !="", ...string & !=""], authorityRef: string & !="", evidenceRef: string & !="", ownershipEpoch: string & !="", observedAt: string & !="", exclusiveUntilSettled: true, noSharedEntitlements: true, signature: string & !="", _limit: true & (len(providerAccountIds) <= 256)}
#IacPricingPin: {planDigest: string & !="", inventoryHash: string & !="", modelHash: string & !="", quoteHash: string & !="", evidenceHash: string & !="", validUntil: string & !=""}
#BudgetAuthorityEvent: {type: string & !="", snapshot: #BudgetLedgerSnapshot, reservations: [...#BudgetReservation], reconciliationEvidenceRef?: string}

#IacTargetLiabilityEvidence: {
	evidenceRef:         string & !=""
	targetId:            string & !=""
	tenantId:            string & !=""
	planDigest:          string & =~"^sha256:[a-f0-9]{64}$"
	inventoryHash:       string & =~"^sha256:[a-f0-9]{64}$"
	modelHash:           string & =~"^sha256:[a-f0-9]{64}$"
	quoteHash:           string & =~"^sha256:[a-f0-9]{64}$"
	maximumMicros?:      #Micros
	maximumMicrosExact?: #ProtoJSONMicros
	observedAt:          string & !=""
	validUntil:          string & !=""
	providerAccounts: [#ProviderAccountExposure, ...#ProviderAccountExposure]
	entitlementClaims?: [...#EntitlementClaim]
	if entitlementClaims != _|_ {
		_uniqueEntitlementClaims: #UniqueEntitlementClaims & {claims: entitlementClaims}
	}
	if maximumMicros != _|_ && maximumMicrosExact != _|_ {
		maximumMicros: strconv.Atoi(maximumMicrosExact) & #Micros
	}
	if maximumMicrosExact != _|_ {
		_exactBound: strconv.Atoi(maximumMicrosExact) & #Micros
		_exactTotal: _exactBound & list.Sum([for account in providerAccounts {account.liabilityMicros}])
	}
	if maximumMicrosExact == _|_ {
		maximumMicros: list.Sum([for account in providerAccounts {account.liabilityMicros}])
	}
	_limit: true & (len(providerAccounts) <= 256)
	_unique: {
		for i, left in providerAccounts
		for j, right in providerAccounts
		if j > i {"\(i)/\(j)": true & (left.providerAccountId != right.providerAccountId)}
	}
}
#IacBudgetDisclosure: {
	evaluation:  "allowed" | "bypassed" | "denied" | "unavailable"
	reservation: "not-created" | "held" | "uncertain" | "settled" | "released" | "unknown"
	if evaluation == "denied" {reservation: "not-created"}
}
#IacTargetAdmissionDecision: {
	requestId:            string & !=""
	targetId:             string & !=""
	status:               "admitted" | "denied" | "replay" | "uncertain"
	code:                 string
	message:              string
	budget:               #IacBudgetDisclosure
	requestDigest?:       string
	inventoryHash?:       string
	modelHash?:           string
	quoteHash?:           string
	quote?:               #HostingQuote
	reservation?:         #BudgetReservation
	policyProof?:         #HostingPolicyProof
	unpricedPolicyProof?: #IacUnpricedPolicyProof
	if status == "denied" {
		code: string & !=""
		budget: {evaluation: "denied" | "unavailable", reservation: "not-created"}
	}
	if status == "admitted" && budget.evaluation == "allowed" {
		unpricedPolicyProof?: _|_
		budget: {evaluation: "allowed", reservation: "held"}
		requestDigest: string & =~"^sha256:[a-f0-9]{64}$"
		inventoryHash: string & =~"^sha256:[a-f0-9]{64}$"
		modelHash:     string & =~"^sha256:[a-f0-9]{64}$"
		quoteHash:     string & =~"^sha256:[a-f0-9]{64}$"
		quote:         #HostingQuote
		reservation:   #BudgetReservation
		policyProof:   #HostingPolicyProof
		_requestID:    requestDigest
		_quoteID:      quote.quoteId
		quote: {
			requestDigest: _requestID
			yardId:        targetId
			ownerTenantId: reservation.identity.tenantId
		}
		reservation: {
			requestDigest:   _requestID
			quoteId:         _quoteID
			status:          "held"
			reservedMicros:  quote.liabilityBoundMicros
			executionDigest: string & =~"^sha256:[a-f0-9]{64}$"
		}
		policyProof: {
			requestDigest:        _requestID
			quoteId:              _quoteID
			identity:             reservation.identity
			effect:               "allow" | "allow-degraded"
			obligationsSatisfied: true
		}
	}
	if status == "admitted" && budget.evaluation == "bypassed" {
		budget: {reservation: "held"}
		modelHash?:    ""
		quoteHash?:    ""
		quote?:        _|_
		policyProof?:  _|_
		requestDigest: string & =~"^sha256:[a-f0-9]{64}$"
		inventoryHash: string & =~"^sha256:[a-f0-9]{64}$"
		_requestID:    requestDigest
		_inventoryID:  inventoryHash
		_identity:     reservation.identity
		_policy:       unpricedPolicyProof
		reservation: {status: "held", unboundedExposure: true, requestDigest: _requestID, financialPlanHash: _inventoryID, executionDigest: string & =~"^sha256:[a-f0-9]{64}$", unpricedPolicyProof: _policy, unpricedScopeProof: {identity: _identity}}
		unpricedPolicyProof: {requestDigest: _requestID, inventoryHash: _inventoryID, identity: _identity, effect: "allow" | "allow-degraded", obligationsSatisfied: true}
	}
	if status == "admitted" {budget: {evaluation: "allowed" | "bypassed"}}
	if status == "replay" {
		code: "EXECUTION_ALREADY_CLAIMED"
		budget: {evaluation: "allowed" | "bypassed", reservation: "held"}
	}
	if status == "uncertain" {
		code: string & !=""
		budget: {evaluation: "unavailable", reservation: "unknown" | "held" | "uncertain"}
	}
}

// Fixture root for the provider-neutral admission boundary.
#Budget: {
	iacEvidence?: #IacTargetLiabilityEvidence
	iacDecision?: #IacTargetAdmissionDecision
	if iacDecision != _|_ && iacDecision.status == "admitted" && iacDecision.budget.evaluation == "allowed" {
		_admittedQuote:       iacDecision.quote & #HostingQuote
		_admittedReservation: iacDecision.reservation & #BudgetReservation & {iacPricingPin: #IacPricingPin}
		iacEvidence: #IacTargetLiabilityEvidence & {
			targetId:      iacDecision.targetId
			tenantId:      iacDecision.quote.ownerTenantId
			planDigest:    iacDecision.reservation.iacPricingPin.planDigest
			inventoryHash: iacDecision.inventoryHash
			modelHash:     iacDecision.modelHash
			quoteHash:     iacDecision.quoteHash
		}
		if iacEvidence.maximumMicrosExact != _|_ {
			iacEvidence: {maximumMicrosExact: strconv.FormatInt(iacDecision.quote.liabilityBoundMicros, 10)}
		}
		if iacEvidence.maximumMicrosExact == _|_ {
			iacEvidence: {maximumMicros: iacDecision.quote.liabilityBoundMicros}
		}
		iacEvidence: {entitlementClaims: [...#EntitlementClaim]}
		_evidenceQuoteAccounts: #ProviderAccountRowsMatch & {
			left:  iacEvidence.providerAccounts
			right: iacDecision.quote.providerAccounts
		}
		_quoteReservationAccounts: #ProviderAccountRowsMatch & {
			left:  iacDecision.quote.providerAccounts
			right: iacDecision.reservation.providerAccounts
		}
		_evidenceQuoteClaims: #EntitlementClaimRowsMatch & {
			left:  iacEvidence.entitlementClaims
			right: iacDecision.quote.entitlementClaims
		}
		_quoteReservationClaims: #EntitlementClaimRowsMatch & {
			left:  iacDecision.quote.entitlementClaims
			right: iacDecision.reservation.entitlementClaims
		}
	}
}
