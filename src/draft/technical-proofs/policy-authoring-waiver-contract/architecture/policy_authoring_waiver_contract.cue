
package architecture_evidence

#PolicyAuthoringWaiverContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyAuthoringWaiverContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
