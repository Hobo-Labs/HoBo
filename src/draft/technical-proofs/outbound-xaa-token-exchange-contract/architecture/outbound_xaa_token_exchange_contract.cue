
package architecture_evidence

#OutboundXaaTokenExchangeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OutboundXaaTokenExchangeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
