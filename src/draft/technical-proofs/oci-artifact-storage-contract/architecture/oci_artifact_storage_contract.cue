
package architecture_evidence

#OciArtifactStorageContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OciArtifactStorageContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
