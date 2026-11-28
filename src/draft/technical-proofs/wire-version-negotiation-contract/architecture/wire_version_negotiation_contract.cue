
package architecture_evidence

#WireVersionNegotiationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WireVersionNegotiationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
