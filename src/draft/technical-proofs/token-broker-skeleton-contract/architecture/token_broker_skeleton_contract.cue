
package architecture_evidence

#TokenBrokerSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TokenBrokerSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
