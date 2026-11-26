// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#AgentGuardrailsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AgentGuardrailsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
