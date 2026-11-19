
package architecture_evidence

#RelationalProjectionSinkContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RelationalProjectionSinkContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
