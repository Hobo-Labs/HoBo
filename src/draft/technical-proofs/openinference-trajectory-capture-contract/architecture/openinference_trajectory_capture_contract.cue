
package architecture_evidence

#OpeninferenceTrajectoryCaptureContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OpeninferenceTrajectoryCaptureContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
