
package architecture_evidence

#HoboDnsPortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboDnsPortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
