
package architecture_evidence

#ControlPlanePlannerMatchingOrchestratorEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ControlPlanePlannerMatchingOrchestratorRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
