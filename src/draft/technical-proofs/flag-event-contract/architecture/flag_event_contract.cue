
package architecture_evidence

#FlagEventContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#FlagEventContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
