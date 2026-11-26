package architecture_evidence

#StubImplementationGenerationEvidenceKind: "unspecified" | "design-record" | "contract-test"

#StubImplementationGenerationRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
