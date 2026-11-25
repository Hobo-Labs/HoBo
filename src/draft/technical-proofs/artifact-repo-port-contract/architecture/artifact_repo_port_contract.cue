
package architecture_evidence

#ArtifactRepoPortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ArtifactRepoPortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
