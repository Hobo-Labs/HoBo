
package architecture_evidence

#RbacRoleBindingContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RbacRoleBindingContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
