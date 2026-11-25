
package architecture_evidence

#ProjectionLagConsistencyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProjectionLagConsistencyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
