
package architecture_evidence

#OperatorsSreCrewEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OperatorsSreCrewRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
