package hobo

#DepotCapabilityRecord: {
	port:      "hobo:runner" | "hobo:build-machine"
	interface: "hobo:runner/job" | "hobo:build-machine/host"
	version:   =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	stability: "preview"
	features: [...string] & !=[]
}

#DepotCostFactRecord: {
	sku:                  "runner.minutes" | "build.minutes"
	unit:                 "minute"
	marginalPrice:        =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded:     uint
	declaredCacheHitRate: =~"^0\\.[0-9]+$" | ""
	sourceType:           "declared-provider"
	sourceDigest:         =~"^sha256:"
}

#DepotAuthPostureRecord: {
	schema:        "hobo.provider-auth/v1"
	mode:          "oidc-trust-exchange"
	tokenAudience: "api.depot.dev"
	exchange:      "hobo:brokered-depot-project-token"
	staticSecrets: false
}

#DepotBuildHandleRecord: {
	buildId:      string & !=""
	depotBuildId: string & !=""
	projectId:    string & !=""
}

#CacheHitObservedRecord: {
	type?:         "build.CacheHitObserved"
	buildId:       string & !=""
	depotBuildId:  string & !=""
	providerId:    string & !=""
	cacheLane:     "depot-shared-cache"
	cacheHitRatio: (number & >=0 & <=1) | =~"^(0(\\.[0-9]+)?|1(\\.0+)?)$"
	meteredUnits:  (number & >=0) | =~"^[0-9]+(\\.[0-9]+)?$"
	estimatedUnits?: number & >0
	source:        "observed-executor"
}
