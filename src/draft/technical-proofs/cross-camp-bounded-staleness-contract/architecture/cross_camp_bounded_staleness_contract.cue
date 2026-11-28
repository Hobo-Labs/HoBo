
package architecture_evidence

#CrossCampBoundedStalenessContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CrossCampBoundedStalenessContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
