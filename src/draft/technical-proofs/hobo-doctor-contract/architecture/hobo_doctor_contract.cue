
package architecture_evidence

#HoboDoctorContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboDoctorContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
