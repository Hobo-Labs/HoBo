
package architecture_evidence

#CrewEventContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CrewEventContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
