
package architecture_evidence

#ReleaseArtifactProvenanceRetentionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ReleaseArtifactProvenanceRetentionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
