
package architecture_evidence

#CapabilityIndexedDiscoveryContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CapabilityIndexedDiscoveryContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
