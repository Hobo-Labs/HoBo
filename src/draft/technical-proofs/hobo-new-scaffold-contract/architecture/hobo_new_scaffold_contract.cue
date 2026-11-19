
package architecture_evidence

#HoboNewScaffoldContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboNewScaffoldContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
