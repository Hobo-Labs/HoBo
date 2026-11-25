
package architecture_evidence

#SloGamingGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SloGamingGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
