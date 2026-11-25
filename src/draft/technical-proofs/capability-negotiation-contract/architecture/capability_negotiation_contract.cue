
package architecture_evidence

#CapabilityNegotiationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CapabilityNegotiationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
