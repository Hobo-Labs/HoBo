
package architecture_evidence

#SreDiagnoseProjectionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SreDiagnoseProjectionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
