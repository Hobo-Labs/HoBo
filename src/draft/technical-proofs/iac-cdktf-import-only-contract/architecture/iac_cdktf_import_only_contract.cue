
package architecture_evidence

#IacCdktfImportOnlyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IacCdktfImportOnlyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
