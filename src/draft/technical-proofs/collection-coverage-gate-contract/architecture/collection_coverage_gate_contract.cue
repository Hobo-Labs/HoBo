
package architecture_evidence

#CollectionCoverageGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CollectionCoverageGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
