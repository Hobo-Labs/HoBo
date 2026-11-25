
package architecture_evidence

#EntitlementsPlanLimitsScopeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#EntitlementsPlanLimitsScopeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
