// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#RegistryCapabilityManifestIngestEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RegistryCapabilityManifestIngestRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
