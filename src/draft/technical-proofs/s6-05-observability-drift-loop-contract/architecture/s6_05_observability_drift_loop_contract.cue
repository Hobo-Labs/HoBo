
package architecture_evidence

#S605ObservabilityDriftLoopEvidenceKind: "unspecified" | "design-record" | "contract-test"

#S605ObservabilityDriftLoopRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
