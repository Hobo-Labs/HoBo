package data_models

#Decimal:            string & =~"^-?(0|[1-9][0-9]*)(\\.[0-9]+)?$"
#NonNegativeDecimal: string & =~"^(0|[1-9][0-9]*)(\\.[0-9]+)?$"
#PositiveDecimal:    string & =~"^([1-9][0-9]*(\\.[0-9]+)?|0\\.[0-9]*[1-9][0-9]*)$"
#ZeroDecimal:        string & =~"^0(\\.0+)?$"
#Currency:           string & =~"^[A-Z]{3}$"
#UtcTimestamp:       string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$"
#Digest:             string & =~"^sha256:[0-9a-f]{64}$"
#StringMap: {[string]: string & !=""}

#Money: {
	decimal:  #Decimal
	currency: #Currency
}

#NonNegativeMoney: #Money & {decimal: #NonNegativeDecimal}

#Quantity: {
	decimal: #NonNegativeDecimal
	unit:    string & !=""
}

#Rounding: {
	scope:    "event" | "period"
	multiple: #PositiveDecimal
	mode:     "ceil" | "floor" | "half-up"
}

#MeterDefinition: {
	dimension:   string & !=""
	unit:        string & !=""
	aggregation: "sum" | "max" | "latest" | "unique-count"
	rounding:    #Rounding
}

#ProviderProduct: {
	id:         string & !=""
	providerId: string & !=""
	meters: [...#MeterDefinition] & [_, ...]
}

#EffectiveInterval: {
	start: #UtcTimestamp
	end?:  #UtcTimestamp
}

#Evidence: {
	source:       string & !=""
	observedAt:   #UtcTimestamp
	validFrom:    #UtcTimestamp
	validUntil:   #UtcTimestamp
	evidenceHash: #Digest
}

#Tier: {
	from:       #NonNegativeDecimal
	to?:        #NonNegativeDecimal
	flatAmount: #NonNegativeMoney
	unitAmount: #NonNegativeMoney
}

#PackagePrice: {
	packageSize:   #PositiveDecimal
	packageAmount: #NonNegativeMoney
	rounding:      #Rounding
}

#TieredPrice: {
	tiers: [...#Tier] & [_, ...]
}

#FixedCharge: {
	cadence:            "once" | "daily" | "weekly" | "monthly" | "yearly"
	timing:             "advance" | "arrears"
	amount:             #NonNegativeMoney
	quantityDimension?: string & !=""
	proration:          "none" | "calendar-day" | "exact-second"
}

#UsageCharge: {
	dimension:  string & !=""
	timing:     "advance" | "arrears"
	perUnit?:   #NonNegativeMoney
	package?:   #PackagePrice
	graduated?: #TieredPrice
	volume?:    #TieredPrice
	_hasPrice:  true & ((perUnit != _|_) | (package != _|_) | (graduated != _|_) | (volume != _|_))
	if perUnit != _|_ {
		package?:   _|_
		graduated?: _|_
		volume?:    _|_
	}
	if package != _|_ {
		perUnit?:   _|_
		graduated?: _|_
		volume?:    _|_
	}
	if graduated != _|_ {
		perUnit?: _|_
		package?: _|_
		volume?:  _|_
	}
	if volume != _|_ {
		perUnit?:   _|_
		package?:   _|_
		graduated?: _|_
	}
}

#ChargeBase: {
	id:              string & !=""
	selectors:       #StringMap
	exclusiveGroup?: string & !=""
	fallback:        bool
	invoiceBehavior: string & !=""
}

#ChargeComponent: {
	base:               #ChargeBase
	fixed?:             #FixedCharge
	usage?:             #UsageCharge
	_exactlyOneVariant: true & ((fixed != _|_) != (usage != _|_))
}

#RateCard: {
	id:        string & !=""
	version:   string & !=""
	currency:  #Currency
	effective: #EffectiveInterval
	charges: [...#ChargeComponent] & [_, ...]
	_exclusiveGroups: {
		for i, left in charges
		for j, right in charges
		if j > i
		if left.base.exclusiveGroup != _|_
		if right.base.exclusiveGroup != _|_
		if left.base.exclusiveGroup == right.base.exclusiveGroup {
			"\(i)/\(j)": true & (left.base.fallback != right.base.fallback)
		}
	}
}

#RateScheduleEntry: {
	rateCardId: string & !=""
	effective:  #EffectiveInterval
}

#BillingPeriod: {
	interval: "daily" | "weekly" | "monthly" | "yearly"
	anchor:   #UtcTimestamp
	timeZone: "UTC"
}

#CancellationPolicy: {
	allowed: bool
	refund:  "none" | "prorated" | "full"
	fee:     #NonNegativeMoney
	notice:  string
}

#ProviderAgreement: {
	id:                 string & !=""
	tenantId:           string & !=""
	providerAccountRef: string & !=""
	productId:          string & !=""
	rateSchedule: [...#RateScheduleEntry] & [_, ...]
	status:        "trialing" | "active" | "past-due" | "suspended" | "cancelled"
	term:          #EffectiveInterval
	billingPeriod: #BillingPeriod
	quantities: {[string]: #NonNegativeDecimal}
	cancellation: #CancellationPolicy
	evidence:     #Evidence
}

#GrantScope: {
	productIds: [...string & !=""]
	rateCardIds: [...string & !=""]
	chargeIds: [...string & !=""]
	dimensions: [...string & !=""]
}

#GrantRecurrence: {
	interval:     "none" | "daily" | "weekly" | "monthly" | "yearly"
	occurrences?: uint & >=1
	if interval == "none" {occurrences?: _|_}
}

#Rollover: {
	max:   #NonNegativeDecimal
	reset: bool
}

#AllowanceGrant: {
	id:           string & !=""
	tenantId:     string & !=""
	included:     #Quantity
	scope:        #GrantScope
	derivedFrom?: string & !=""
	recurrence:   #GrantRecurrence
	effective:    #EffectiveInterval
	rollover:     #Rollover
	exhaustion:   "bill-overage" | "block-usage"
	priority:     int & >=0
	evidence:     #Evidence
}

#CreditValue: {
	money?:           #Money
	quantity?:        #Quantity
	_exactlyOneValue: true & ((money != _|_) != (quantity != _|_))
}

#EconomicBasis: {
	kind:               "zero" | "acquisition" | "face-value"
	acquisitionAmount?: #NonNegativeMoney
	if kind == "acquisition" {acquisitionAmount: #NonNegativeMoney}
	if kind != "acquisition" {acquisitionAmount?: _|_}
}

#CreditGrant: {
	id:            string & !=""
	tenantId:      string & !=""
	category:      "paid" | "promotional" | "support-adjustment"
	faceValue:     #CreditValue
	economicBasis: #EconomicBasis
	scope:         #GrantScope
	derivedFrom?:  string & !=""
	effective:     #EffectiveInterval
	recurrence:    #GrantRecurrence
	rollover:      #Rollover
	priority:      int & >=0
	evidence:      #Evidence
	if derivedFrom != _|_ {
		if economicBasis.kind == "face-value" {economicBasis: {kind: "zero"}}
		if economicBasis.kind == "acquisition" {
			economicBasis: {acquisitionAmount: {decimal: #ZeroDecimal}}
		}
	}
}

#CommitmentAmount: {
	money?:           #NonNegativeMoney
	quantity?:        #Quantity
	_exactlyOneValue: true & ((money != _|_) != (quantity != _|_))
}

#Commitment: {
	id:                string & !=""
	tenantId:          string & !=""
	kind:              "spend" | "usage"
	amount:            #CommitmentAmount
	bucketGranularity: "hour" | "day" | "month" | "billing-period" | "term"
	term:              #EffectiveInterval
	payment:           "upfront" | "recurring" | "mixed"
	underuse:          "forfeit" | "rollover" | "true-up"
	amortization:      "straight-line" | "provider-actual"
	scope:             #GrantScope
	evidence:          #Evidence
	if kind == "spend" {amount: {money: #NonNegativeMoney, quantity?: _|_}}
	if kind == "usage" {amount: {quantity: #Quantity, money?: _|_}}
}

#PricingCatalog: {
	schema:      "hobo.pricing.catalog/v1"
	catalogHash: #Digest
	products: [...#ProviderProduct]
	rateCards: [...#RateCard]
	allowances: [...#AllowanceGrant]
	credits: [...#CreditGrant]
	commitments: [...#Commitment]
}

#AllowanceState: {
	grant:     #AllowanceGrant
	remaining: #Quantity
	used:      #Quantity
}

#CreditState: {
	grant:          #CreditGrant
	remaining:      #CreditValue
	used:           #CreditValue
	remainingBasis: #NonNegativeMoney
	usedBasis:      #NonNegativeMoney
}

#CommitmentState: {
	commitment: #Commitment
	remaining:  #CommitmentAmount
	used:       #CommitmentAmount
}

#ActualCharge: {
	id:               string & !=""
	agreementId:      string & !=""
	chargeId:         string & !=""
	billedCost:       #Money
	effectiveCost:    #Money
	listCost:         #Money
	contractedCost:   #Money
	category:         "usage" | "purchase" | "credit" | "adjustment" | "tax"
	commitmentStatus: string & !=""
	observedAt:       #UtcTimestamp
}

#StateObservation: {
	source:     string & !=""
	observedAt: #UtcTimestamp
	validUntil: #UtcTimestamp
	detail:     string
}

#FinancialStateView: {
	schema:    "hobo.pricing/v1"
	view:      string & !=""
	tenantId:  string & !=""
	seq:       int & >=0
	stateHash: #Digest
	asOf:      #UtcTimestamp
	agreements: [...#ProviderAgreement]
	allowances: [...#AllowanceState]
	credits: [...#CreditState]
	commitments: [...#CommitmentState]
	periodActuals: [...#ActualCharge]
	completeness: "complete" | "partial"
	observations: [...#StateObservation]
}

#UsageMeasurement: {
	dimension:  string & !=""
	quantity:   #Quantity
	observedAt: #UtcTimestamp
	uniqueValues: [...string & !=""]
}

#WorkloadDelta: {
	productRef:   string & !=""
	agreementRef: string & !=""
	direction:    "add" | "remove"
	quantities: {[string]: #NonNegativeDecimal}
	usage: [...#UsageMeasurement]
	attributes: #StringMap
}

#QuoteOptions: {
	allowNewProviderAgreement: bool
	allowCancellation:         bool
	amortization:              "straight-line" | "provider-actual"
	allocationConvention:      "marginal-consume" | "period-proportional"
	allocationForecast: [...#UsageMeasurement]
}

#QuoteScenario: {
	action:             "place" | "dispatch" | "rebalance" | "migrate" | "cancel"
	at:                 #UtcTimestamp
	horizon:            #UtcTimestamp
	pricingCatalogHash: #Digest
	catalog:            #PricingCatalog
	state:              #FinancialStateView
	baseline: [...#WorkloadDelta]
	candidate: [...#WorkloadDelta]
	sourceProviderAgreementIds: [...string & !=""]
	options:            #QuoteOptions
	pricingCatalogHash: catalog.catalogHash
}

#QuoteAmounts: {
	billed:    #Money
	dueNow:    #Money
	effective: #Money
}

#QuoteLine: {
	chargeId:     string & !=""
	agreementRef: string & !=""
	productRef:   string & !=""
	description:  string
	quantity:     #Quantity
	unitPrice:    #Money
	billed:       #Money
	effective:    #Money
	dueNow:       #Money
	category:     "usage" | "purchase" | "credit" | "adjustment" | "tax"
	grantIds: [...string & !=""]
	commitmentIds: [...string & !=""]
}

#Consumption: {
	sourceId:  string & !=""
	kind:      "allowance" | "credit" | "commitment"
	dimension: string & !=""
	quantity:  #Quantity
}

#RemainingHeadroom: {
	sourceId:  string & !=""
	dimension: string & !=""
	quantity:  #Quantity
}

#ProjectedWaste: {
	commitmentId: string & !=""
	bucketStart:  #UtcTimestamp
	bucketEnd:    #UtcTimestamp
	amount:       #CommitmentAmount
}

#NewObligation: {
	agreementRef: string & !=""
	commitmentId: string & !=""
	amount:       #CommitmentAmount
	dueAt:        #UtcTimestamp
}

#UnpricedItem: {
	productRef:   string & !=""
	agreementRef: string & !=""
	chargeId:     string & !=""
	reason:       string & !=""
}

#RejectedCandidate: {
	candidateRef: string & !=""
	code:         string & =~"^[A-Z][A-Z0-9_]+$"
	reason:       string & !=""
}

#Eligibility: {
	eligible: bool
	rejectedCandidates: [...#RejectedCandidate]
}

#PricingRejected: {
	schema:   "hobo.pricing.rejected/v1"
	code:     string & =~"^[A-Z][A-Z0-9_]+$"
	message:  string & !=""
	unpriced: [...#UnpricedItem]
	rejectedCandidates: [...#RejectedCandidate]
}

#QuoteVector: {
	schema:                 "hobo.pricing.quote/v1"
	ratingAlgorithmVersion: string & !=""
	pricingCatalogHash:     #Digest
	capabilityCatalogHash:  #Digest
	stateHash:              #Digest
	quoteHash:              #Digest
	baseline:               #QuoteAmounts
	candidate:              #QuoteAmounts
	incremental:            #QuoteAmounts
	allocationConvention:   "marginal-consume" | "period-proportional"
	allocatedEffective:     #Money
	nominalAtListRate:      #Money
	newObligations: [...#NewObligation]
	migrationAndTermination: #Money
	lines: [...#QuoteLine]
	consumption: [...#Consumption]
	remainingHeadroom: [...#RemainingHeadroom]
	projectedWaste: [...#ProjectedWaste]
	assumptions: [...string]
	unpriced: [...#UnpricedItem]
	eligibility: #Eligibility
}

#ExternalProviderQuote: {
	id:                 string & !=""
	providerAccountRef: string & !=""
	productId:          string & !=""
	currency:           #Currency
	effective:          #EffectiveInterval
	observedAt:         #UtcTimestamp
	payloadHash:        #Digest
	total:              #Money
	lines: [...#QuoteLine]
}

#ReservationConsumption: {
	sourceId:    string & !=""
	kind:        "credit" | "allowance" | "commitment"
	credit?:     #CreditValue
	allowance?:  #Quantity
	commitment?: #CommitmentAmount
	if kind == "credit" {
		credit:      #CreditValue
		allowance?:  _|_
		commitment?: _|_
	}
	if kind == "allowance" {
		allowance:   #Quantity
		credit?:     _|_
		commitment?: _|_
	}
	if kind == "commitment" {
		commitment: #CommitmentAmount
		credit?:    _|_
		allowance?: _|_
	}
}

#PricingReservation: {
	id:                    string & !=""
	quoteHash:             #Digest
	pricingCatalogHash:    #Digest
	capabilityCatalogHash: #Digest
	stateHash:             #Digest
	stateSeq:              int & >=0
	createdAt:             #UtcTimestamp
	expiresAt:             #UtcTimestamp
	status:                "pending" | "confirmed" | "released" | "expired"
	consumption: [...#ReservationConsumption]
	restoreState: #FinancialStateView
}

#RateCardPublished: {
	eventId:    string & !=""
	occurredAt: #UtcTimestamp
	rateCard:   #RateCard
}

#ProviderAgreementObserved: {
	eventId:    string & !=""
	occurredAt: #UtcTimestamp
	agreement:  #ProviderAgreement
}

#GrantObserved: {
	eventId:          string & !=""
	occurredAt:       #UtcTimestamp
	allowance?:       #AllowanceGrant
	credit?:          #CreditGrant
	_exactlyOneGrant: true & ((allowance != _|_) != (credit != _|_))
}

#CommitmentObserved: {
	eventId:    string & !=""
	occurredAt: #UtcTimestamp
	commitment: #Commitment
}

#QuoteCreated: {
	eventId:    string & !=""
	occurredAt: #UtcTimestamp
	scenario:   #QuoteScenario
	quote:      #QuoteVector
}

#ReservationCreated: {
	eventId:     string & !=""
	occurredAt:  #UtcTimestamp
	reservation: #PricingReservation
}

#ReservationConfirmed: {
	eventId:       string & !=""
	occurredAt:    #UtcTimestamp
	reservationId: string & !=""
	stateSeq:      int & >=0
}

#ReservationReleased: {
	eventId:       string & !=""
	occurredAt:    #UtcTimestamp
	reservationId: string & !=""
	stateSeq:      int & >=0
	restoredState: #FinancialStateView
}

#ReservationExpired: {
	eventId:       string & !=""
	occurredAt:    #UtcTimestamp
	reservationId: string & !=""
	stateSeq:      int & >=0
	restoredState: #FinancialStateView
}

#ActualChargeObserved: {
	eventId:      string & !=""
	occurredAt:   #UtcTimestamp
	actualCharge: #ActualCharge
}

#ReconciliationRecorded: {
	eventId:       string & !=""
	occurredAt:    #UtcTimestamp
	reservationId: string & !=""
	actualCharges: [...#ActualCharge]
	reconciliationHash: #Digest
}

#PricingFixture: {
	catalog:   #PricingCatalog
	state?:    #FinancialStateView
	scenario?: #QuoteScenario
	quote?:    #QuoteVector
	externalQuotes?: [...#ExternalProviderQuote]
}

#Pricing: #PricingFixture
