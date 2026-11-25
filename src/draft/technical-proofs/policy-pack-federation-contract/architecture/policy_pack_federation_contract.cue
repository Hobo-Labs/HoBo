
package architecture_evidence

#PolicyPackFederationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyPackFederationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
