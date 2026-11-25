
package architecture_evidence

#DataParadigmAuthoringContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DataParadigmAuthoringContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
