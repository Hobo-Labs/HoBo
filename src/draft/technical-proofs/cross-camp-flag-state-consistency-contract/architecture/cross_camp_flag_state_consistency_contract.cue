
package architecture_evidence

#CrossCampFlagStateConsistencyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CrossCampFlagStateConsistencyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
