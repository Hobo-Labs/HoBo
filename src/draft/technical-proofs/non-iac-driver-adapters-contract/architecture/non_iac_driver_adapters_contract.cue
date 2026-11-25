
package architecture_evidence

#NonIacDriverAdaptersContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#NonIacDriverAdaptersContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
