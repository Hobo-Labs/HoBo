
package architecture_evidence

#JunctionConnectivityPlanContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#JunctionConnectivityPlanContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
