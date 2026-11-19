
package architecture_evidence

#CapabilityEnforcementContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CapabilityEnforcementContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
