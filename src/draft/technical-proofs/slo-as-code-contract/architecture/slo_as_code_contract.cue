
package architecture_evidence

#SloAsCodeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SloAsCodeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
