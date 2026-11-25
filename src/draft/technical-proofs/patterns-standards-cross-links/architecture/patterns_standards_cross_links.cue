package architecture_evidence

#PatternsStandardsCrossLinksEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PatternsStandardsCrossLinksRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
