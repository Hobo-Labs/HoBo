package architecture_evidence

#S121CollectCodegenCliPocEvidenceKind: "unspecified" | "design-record" | "contract-test"

#S121CollectCodegenCliPocRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
