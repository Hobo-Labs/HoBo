
package architecture_evidence

#DispatcherMaximizeCreditsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DispatcherMaximizeCreditsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
