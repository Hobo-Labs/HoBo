
package architecture_evidence

#ContractsPolicyGovernanceEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ContractsPolicyGovernanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
