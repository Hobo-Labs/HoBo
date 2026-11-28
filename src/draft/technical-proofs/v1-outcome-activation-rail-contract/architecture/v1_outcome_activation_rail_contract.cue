
package architecture_evidence

#V1OutcomeActivationRailContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#V1OutcomeActivationRailContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
