
package architecture_evidence

#PortabilityRegistryDistributionEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PortabilityRegistryDistributionRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
