// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

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
	// Every diagnostic bundle can always show the four fields support needs
	// to locate the incident; REQUIRED_DIAGNOSTIC_FIELDS in
	// support-debug-tools-scope.ts checks membership, not position.
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
