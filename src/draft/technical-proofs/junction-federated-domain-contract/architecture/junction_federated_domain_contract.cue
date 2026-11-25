
package architecture_evidence

#JunctionFederatedDomainContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#JunctionFederatedDomainContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
