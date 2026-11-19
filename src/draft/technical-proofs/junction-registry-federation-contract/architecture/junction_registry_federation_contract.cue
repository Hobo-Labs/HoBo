
package architecture_evidence

#JunctionRegistryFederationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#JunctionRegistryFederationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
