package hobo

// CUE constraints for the GitHub Actions execution-host wire records. One
// constraint per protobuf message in runner_github.proto.

#ExecutionHostCapability: {
	port:      "hobo:runner" | "hobo:build-machine"
	interface: "hobo:runner/job" | "hobo:build-machine/host"
	version:   =~"^[0-9]+\\.[0-9]+\\.[0-9]+$"
	stability: "preview"
	features: [...string] & !=[]
}

#ExecutionHostCostFactRecord: {
	sku:              "runner.minutes" | "build.minutes"
	unit:             "minute"
	marginalPrice:    =~"^[0-9]+\\.[0-9]+$"
	freeTierIncluded: uint
	sourceType:       "declared-provider"
	sourceDigest:     =~"^sha256:"
}

#AuthPosture: {
	schema:        "hobo.provider-auth/v1"
	mode:          "github-app-installation"
	tokenAudience: "api.github.com"
	exchange:      "hobo:brokered-installation-token"
	staticSecrets: false
}

#RunnerJobRecord: {
	jobId:          string & !=""
	workflow:       string & !=""
	ref:            string & !=""
	command:        string
	estimatedUnits: uint
}

#RunnerResultRecord: {
	providerId: string & !=""
	category:   "runner" | "build-machine"
	jobId:      string & !=""
	status:     "succeeded" | "failed"
	runId:      uint
	runUrl:     string
}

#DispatchCandidateRecord: {
	provider:              string & !=""
	effectiveMarginalCost: =~"^[0-9]"
}

#DispatchDecidedRecord: {
	dispatchId:       string & !=""
	category:         "runner" | "build-machine"
	selectedProvider: string & !=""
	objective:        "cost" | "latency" | "single-provider" | "carbon" | "maximize-credits"
	ledgerSeq:        uint
	balanceHash:      string & !=""
	candidates: [...#DispatchCandidateRecord] & !=[]
}

#ImageRefRecord: {
	mediaType: string & !=""
	uri:       =~"^oci://"
	digest:    =~"^sha256:"
}
