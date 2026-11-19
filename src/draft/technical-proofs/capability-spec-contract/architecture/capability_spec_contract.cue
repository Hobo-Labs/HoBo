
package architecture_evidence

#CapabilitySpecContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CapabilitySpecContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
