
package architecture_evidence

#RegistryCapabilityManifestIngestEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RegistryCapabilityManifestIngestRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
