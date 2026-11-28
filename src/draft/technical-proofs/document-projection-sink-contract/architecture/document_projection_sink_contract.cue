
package architecture_evidence

#DocumentProjectionSinkContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DocumentProjectionSinkContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
