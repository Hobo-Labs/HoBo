
package architecture_evidence

#DispatcherReservationHardeningContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DispatcherReservationHardeningContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
