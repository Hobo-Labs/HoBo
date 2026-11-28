
package architecture_evidence

import "list"

#SupportDebugToolsEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "audit-fixture" | "support-handoff" | "policy-fixture" | "replay-fixture"

#SupportDebugDiagnosticBundleClass: {
	id:                 string & !=""
	owner:              string & !=""
	eventFamilies:      [...string]
	customerVisible:    bool
	redactionRequired:  true
	safeFields:         [...string]
	_baselineFieldsAreSafe: true & (
		list.Contains(safeFields, "tenant") &&
		list.Contains(safeFields, "project") &&
		list.Contains(safeFields, "environment") &&
		list.Contains(safeFields, "correlation-id"))
}

#SupportDebugRecoveryRoute: {
	id:                string & !=""
	owner:             string & !=""
	trigger:           string & !=""
	safeNextAction:    string & !=""
	mutationAllowed:   false
}

#SupportDebugToolsScopeRecord: {
	issue:             "HOBO-426"
	summary:           string & !=""
	personas:          [...string]
	diagnosticBundles: [...#SupportDebugDiagnosticBundleClass]
	recoveryRoutes:    [...#SupportDebugRecoveryRoute]
	evidence:          [...string]
}
