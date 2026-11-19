
package architecture_evidence

#OrganizationWorkspaceModelContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OrganizationWorkspaceModelContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
