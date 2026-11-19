
package architecture_evidence

#ComponentHostOciFloorContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ComponentHostOciFloorContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
