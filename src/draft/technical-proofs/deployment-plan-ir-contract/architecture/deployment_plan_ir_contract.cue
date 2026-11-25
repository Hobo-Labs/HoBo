
package architecture_evidence

#DeploymentPlanIrContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DeploymentPlanIrContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
