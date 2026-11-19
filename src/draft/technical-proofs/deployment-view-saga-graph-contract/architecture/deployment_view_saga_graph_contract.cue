
package architecture_evidence

#DeploymentViewSagaGraphContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DeploymentViewSagaGraphContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
