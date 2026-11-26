// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ChaosExperimentOrchestrationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ChaosExperimentOrchestrationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

