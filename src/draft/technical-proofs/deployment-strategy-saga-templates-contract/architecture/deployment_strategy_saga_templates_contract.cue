
package architecture_evidence

#DeploymentStrategySagaTemplatesContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DeploymentStrategySagaTemplatesContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
