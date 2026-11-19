
package architecture_evidence

#TokenBrokerHaCacheContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TokenBrokerHaCacheContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
