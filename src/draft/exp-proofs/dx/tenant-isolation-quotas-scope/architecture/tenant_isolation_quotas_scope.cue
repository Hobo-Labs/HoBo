
package architecture_evidence

#TenantIsolationQuotasScopeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TenantIsolationQuotasScopeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
