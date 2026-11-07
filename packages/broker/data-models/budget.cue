package data_models
import "list"

#BudgetIdentity: {
  tenantId: string & !=""
  budgetId: string & !=""
  periodId: string & !=""
  policyRevision: string & !=""
}
#Micros: int & >=0 & <=9007199254740991
#BudgetLedgerSnapshot: {
  identity: #BudgetIdentity
  seq: int & >=0 & <=4294967295
  limitMicros: #Micros
  spentMicros: #Micros
  reservedMicros: #Micros
  observedAt: string & !=""
  validUntil: string & !=""
  providerAccounts?: [...#BudgetProviderAccount]
  entitlements?: [...#BudgetEntitlement]
  unresolvedMicros?: #Micros
  recoveryReserveMicros?: #Micros
  externalCommittedMicros?: #Micros
}
#BudgetProviderAccount: {providerAccountId: string & !="", limitMicros: #Micros, spentMicros: #Micros, reservedMicros: #Micros, externalCommittedMicros?: #Micros}
#BudgetEntitlement: {bucketId: string & !="", unit: string & !="", periodId: string & !="", remainingUnits: #Micros, reservedUnits: #Micros, observedAt: string & !="", validUntil: string & !=""}
#ProviderAccountExposure: {providerAccountId: string & !="", liabilityMicros: #Micros}
#EntitlementClaim: {bucketId: string & !="", unit: string & !="", units: #Micros}
#HostingQuoteComponent: {name: string & !="", costMicros: #Micros}
#HostingQuote: {
  quoteId: string & !=""
  yardId: string & !=""
  providerId: string & !=""
  ownerTenantId: string & !=""
  currency: "USD"
  totalMicros: #Micros
  liabilityBoundMicros?: #Micros & >=totalMicros
  observedAt: string & !=""
  validUntil: string & !=""
  requestDigest: string & !=""
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
}
#BudgetSettlementEvidence: {usageEvidenceRef: string & !="", sourceStoppedEvidenceRef: string & !="", providerAccounts?: [...#ProviderAccountExposure], entitlementClaims?: [...#EntitlementClaim]}
#HostingPolicyProof: {requestDigest: string & !="", quoteId: string & !="", identity: #BudgetIdentity, policyHash: string & !="", effect: "allow" | "allow-degraded" | "deny" | "require-approval", evidenceRef: string & !="", obligationsSatisfied: bool}
#BudgetAuthorityEvent: {type: string & !="", snapshot: #BudgetLedgerSnapshot, reservations: [...#BudgetReservation], reconciliationEvidenceRef?: string}
