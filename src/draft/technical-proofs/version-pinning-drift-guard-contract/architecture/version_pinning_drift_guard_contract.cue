
package architecture_evidence

#VersionPinningDriftGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#VersionPinningDriftGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
