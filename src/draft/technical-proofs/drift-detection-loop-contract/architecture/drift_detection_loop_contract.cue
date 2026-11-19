
package architecture_evidence

#DriftDetectionLoopContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DriftDetectionLoopContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
