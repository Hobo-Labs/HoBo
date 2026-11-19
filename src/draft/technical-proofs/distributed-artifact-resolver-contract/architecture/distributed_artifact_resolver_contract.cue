
package architecture_evidence

#DistributedArtifactResolverContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DistributedArtifactResolverContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
