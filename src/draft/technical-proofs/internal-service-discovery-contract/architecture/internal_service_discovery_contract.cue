
package architecture_evidence

#InternalServiceDiscoveryContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#InternalServiceDiscoveryContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
