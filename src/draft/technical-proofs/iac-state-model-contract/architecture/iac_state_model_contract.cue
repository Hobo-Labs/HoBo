
package architecture_evidence

#IacStateModelContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IacStateModelContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
