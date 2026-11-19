
package architecture_evidence

#InboundXaaResourceServerContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#InboundXaaResourceServerContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
