
package architecture_evidence

#OperationsManifestsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OperationsManifestsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
