
package architecture_evidence

#OidcFederationStsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OidcFederationStsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
