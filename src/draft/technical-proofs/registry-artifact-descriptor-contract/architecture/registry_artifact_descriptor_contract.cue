
package architecture_evidence

#RegistryArtifactDescriptorContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RegistryArtifactDescriptorContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
