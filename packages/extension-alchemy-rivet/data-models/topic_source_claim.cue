package data_models

#TopicSourceClaim: {
	resourceId:        string & !=""
	resourceType:      "Rivet.DurableObject"
	bindleName:        string & !=""
	applicationName:   resourceId
	sourceKind:        "rivet-async-topic" | "rivet-async-topic-bus"
	sourcePath:        string & !=""
	sourceDigest:      string & =~"^sha256:[a-f0-9]{64}$"
	environmentDigest: string & =~"^sha256:[a-f0-9]{64}$"
	proofRef:          string & !=""
}
