
package architecture_evidence

#CiFabricOidcE2eContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CiFabricOidcE2eContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
