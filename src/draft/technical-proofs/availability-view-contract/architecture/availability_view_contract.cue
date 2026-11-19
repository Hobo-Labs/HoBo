
package architecture_evidence

#AvailabilityViewContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AvailabilityViewContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
