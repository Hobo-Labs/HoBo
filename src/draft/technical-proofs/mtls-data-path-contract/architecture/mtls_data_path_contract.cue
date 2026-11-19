
package architecture_evidence

#MtlsDataPathContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MtlsDataPathContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
