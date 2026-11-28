
package architecture_evidence

#ParadigmIdiomPackagesContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ParadigmIdiomPackagesContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
