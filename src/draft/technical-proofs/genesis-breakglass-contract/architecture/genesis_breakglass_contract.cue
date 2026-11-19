
package architecture_evidence

#GenesisBreakglassContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenesisBreakglassContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
