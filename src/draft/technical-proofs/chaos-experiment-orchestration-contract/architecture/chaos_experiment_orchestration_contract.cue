
package architecture_evidence

#ChaosExperimentOrchestrationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ChaosExperimentOrchestrationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
