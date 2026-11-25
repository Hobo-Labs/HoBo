
package architecture_evidence

#DistributedArtifactVersionPolicyEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DistributedArtifactVersionPolicyRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
