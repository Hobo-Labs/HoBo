
package architecture_evidence

#LiveFixGatedCandidateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LiveFixGatedCandidateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
