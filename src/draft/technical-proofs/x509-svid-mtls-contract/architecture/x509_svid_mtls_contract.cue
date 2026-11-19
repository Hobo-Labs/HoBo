
package architecture_evidence

#X509SvidMtlsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#X509SvidMtlsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
