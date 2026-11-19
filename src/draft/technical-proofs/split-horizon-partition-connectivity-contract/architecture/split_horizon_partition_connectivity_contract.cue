
package architecture_evidence

#SplitHorizonPartitionConnectivityContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SplitHorizonPartitionConnectivityContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
