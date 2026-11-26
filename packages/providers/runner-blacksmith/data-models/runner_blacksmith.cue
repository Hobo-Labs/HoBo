package hobo

// CUE constraints for the Blacksmith.sh execution-host wire records. One
// constraint per protobuf message in runner_blacksmith.proto.

#BlacksmithCapabilityRecord: {
	port:      "hobo:runner" | "hobo:build-machine"
	interface: "hobo:runner/job" | "hobo:build-machine/host"
	version:   =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	stability: "preview"
	features: [...string] & !=[]
	runsOn: =~"^blacksmith-"
}

#BlacksmithCostFactRecord: {
	sku:              "runner.minutes" | "build.minutes"
	unit:             "minute"
	marginalPrice:    =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded: uint
	sourceType:       "declared-provider"
	sourceDigest:     =~"^sha256:"
}

#BlacksmithAuthPostureRecord: {
	schema:            "hobo.provider-auth/v1"
	mode:              "github-app-installation"
	tokenAudience:     "api.github.com"
	exchange:          "hobo:brokered-installation-token"
	substrateExchange: "hobo:brokered-blacksmith-org-token"
	staticSecrets:     false
}

#CacheLaneObservedRecord: {
	buildId:    string & !=""
	providerId: "@hobo/runner-blacksmith"
	runId:      uint
	cacheLane:  "sticky-disk"
	source:     "declared-provider"
}
