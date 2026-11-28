
package architecture_evidence

#ProjectionConsistencyReactivityContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProjectionConsistencyReactivityContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
