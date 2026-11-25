
package architecture_evidence

#RunbookContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RunbookContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
