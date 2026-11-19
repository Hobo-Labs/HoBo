
package architecture_evidence

#HoboContractIrEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboContractIrRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
