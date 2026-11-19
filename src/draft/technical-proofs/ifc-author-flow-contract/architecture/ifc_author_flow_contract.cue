
package architecture_evidence

#IfcAuthorFlowContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IfcAuthorFlowContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
