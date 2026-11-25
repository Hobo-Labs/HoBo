package hobo

// CUE constraints for the Depot execution-host wire records. One constraint
// per protobuf message in runner_depot.proto.

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
	buildId:       string & !=""
	depotBuildId:  string & !=""
	providerId:    "@hobo/runner-depot"
	cacheLane:     "depot-shared-cache"
	cacheHitRatio: =~"^(0(\\.[0-9]+)?|1(\\.0+)?)$"
	meteredUnits:  =~"^[0-9]+(\\.[0-9]+)?$"
	source:        "observed-executor"
}
