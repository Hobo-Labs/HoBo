// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#ProviderAwsFullCatalogEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderAwsFullCatalogRecord: {
	issue:         string & !=""
	summary:       string & !=""
	catalog_ports: [...string]
	evidence:      [...string]
}
