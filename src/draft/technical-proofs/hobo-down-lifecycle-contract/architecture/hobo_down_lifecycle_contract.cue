
package architecture_evidence

#HoboDownLifecycleContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboDownLifecycleContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
