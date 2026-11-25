
package architecture_evidence

#DeliveryOrchestratorSkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DeliveryOrchestratorSkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
