
package architecture_evidence

#SignedArtifactPublishInstallContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SignedArtifactPublishInstallContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
