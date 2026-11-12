package vercel

// Constraints on HOBO_CI_CACHE_OFFERS_JSON (../cache_offers.proto). The
// TypeScript parser in src/cache-offers.ts applies the same ones, then the
// fleet parsers of @hobo/backend-fleet (parseFleetFinancialModel,
// parseFleetOffer, parseFleetRoutingMarks).

#RelayCacheBackend: "upstash" | "valkey" | "redis" | "turso" | "blob" | "memory"

#RelayCacheAllowance: {
	unit:                  "commands" | "rows-read" | "rows-written" | "simple-operations" | "advanced-operations" | "operations"
	included?:             int & >=0
	beyond:                "hard-stop" | "metered" | "unknown"
	meteredMicrosPerUnit?: number & >=0
	// Exactly a metered allowance carries a price.
	if beyond == "metered" {
		meteredMicrosPerUnit: number & >=0
	}
	if beyond != "metered" {
		meteredMicrosPerUnit?: _|_
	}
}

#RelayCacheEvidence: {
	source:     string & =~"^.{1,300}$"
	observedAt: string & =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"
}

#RelayCacheOffer: {
	backend:                #RelayCacheBackend
	tier:                   "free" | "prepaid" | "payg"
	plan:                   string & =~"^[a-z0-9][a-z0-9 ._-]{0,63}$"
	fixedMonthlyFeeMicros?: int & >=0
	capMicros?:             int & >=0
	allowances: [...#RelayCacheAllowance]
	evidence: #RelayCacheEvidence
}

#RelayCacheMarks: {
	switchAtPercent?:        number & >0 & <=100
	switchBackBelowPercent?: number & >0 & <100
	minDwellMinutes?:        int & >=0 & <=44640
	failoverAfterSeconds?:   int & >=0 & <=86400
	// The lower mark is lower, or the fleet flaps.
	if switchAtPercent != _|_ && switchBackBelowPercent != _|_ {
		switchBackBelowPercent: <switchAtPercent
	}
}

#RelayCacheOffers: {
	offers?: [...#RelayCacheOffer]
	marks?: #RelayCacheMarks
}
