
package architecture_evidence

#LocalDevOrchestrationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LocalDevOrchestrationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
