
package architecture_evidence

#ResourceactorFsmContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ResourceactorFsmContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
