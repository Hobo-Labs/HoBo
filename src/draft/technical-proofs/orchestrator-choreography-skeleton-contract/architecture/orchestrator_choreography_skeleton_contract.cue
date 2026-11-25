
package architecture_evidence

#OrchestratorChoreographySkeletonContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OrchestratorChoreographySkeletonContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
