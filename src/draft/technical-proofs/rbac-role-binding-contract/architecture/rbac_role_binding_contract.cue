// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#RbacRoleBindingContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RbacRoleBindingContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

