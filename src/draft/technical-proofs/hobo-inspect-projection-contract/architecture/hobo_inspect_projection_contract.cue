
package architecture_evidence

#HoboInspectProjectionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboInspectProjectionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
