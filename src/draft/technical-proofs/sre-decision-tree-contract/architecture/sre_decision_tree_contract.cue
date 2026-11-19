
package architecture_evidence

#SreDecisionTreeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SreDecisionTreeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
