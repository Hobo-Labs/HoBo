package architecture_evidence

#ContainerFallbackWiringParityEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ContainerFallbackWiringParityRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
