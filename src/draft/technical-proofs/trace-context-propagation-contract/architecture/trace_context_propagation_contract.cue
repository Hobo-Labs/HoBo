
package architecture_evidence

#TraceContextPropagationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TraceContextPropagationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
