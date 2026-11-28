
package architecture_evidence

#WrpcDeadlinePropagationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WrpcDeadlinePropagationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
