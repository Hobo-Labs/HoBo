
package architecture_evidence

#CostSignalContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CostSignalContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
