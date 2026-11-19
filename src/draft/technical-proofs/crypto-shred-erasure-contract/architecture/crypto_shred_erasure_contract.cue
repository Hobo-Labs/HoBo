
package architecture_evidence

#CryptoShredErasureContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CryptoShredErasureContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
