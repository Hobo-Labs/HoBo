
package architecture_evidence

#FlagPartitionConsistencyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FlagPartitionConsistencyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
