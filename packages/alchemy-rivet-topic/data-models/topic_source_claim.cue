package data_models

// Value-level constraints only. The host must authenticate the actor, source
// closure, verifier and exclusive pool; a matching digest alone is not proof.
#TopicSourceClaim: {
	resourceId:        string & !=""
	resourceType:      "Rivet.DurableObject"
	bindleName:        string & !=""
	applicationName:   resourceId
	sourceKind:        "rivet-async-topic"
	sourcePath:        string & !=""
	sourceDigest:      string & =~"^sha256:[a-f0-9]{64}$"
	environmentDigest: string & =~"^sha256:[a-f0-9]{64}$"
	proofRef:          string & !=""
}
