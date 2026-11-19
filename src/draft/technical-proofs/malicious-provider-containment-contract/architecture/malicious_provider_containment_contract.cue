
package architecture_evidence

#MaliciousProviderContainmentContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MaliciousProviderContainmentContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
