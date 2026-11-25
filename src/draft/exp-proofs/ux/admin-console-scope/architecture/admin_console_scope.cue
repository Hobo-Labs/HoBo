
package architecture_evidence

#AdminConsoleScopeEvidenceKind: "unspecified" | "design-record" | "contract-test" | "audit-fixture" | "support-handoff" | "policy-fixture"

#AdminConsoleReadModelClass: {
	id:              string & !=""
	owner:           string & !=""
	customerVisible: bool
	launchCritical:  bool
}

#AdminConsoleScopeRecord: {
	issue:         "HOBO-425"
	summary:       string & !=""
	personas:      [...string]
	readModels:    [...#AdminConsoleReadModelClass]
	actionIntents: [...string]
	evidence:      [...string]
}
