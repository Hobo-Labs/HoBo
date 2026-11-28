
package architecture_evidence

#PolicyGatedFlagFlipsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyGatedFlagFlipsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
