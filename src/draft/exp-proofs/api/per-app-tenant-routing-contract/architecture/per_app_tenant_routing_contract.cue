
package architecture_evidence

#PerAppTenantRoutingContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PerAppTenantRoutingContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
