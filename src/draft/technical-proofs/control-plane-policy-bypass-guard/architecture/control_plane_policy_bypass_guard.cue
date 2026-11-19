
package architecture_evidence

#ControlPlanePolicyBypassGuardEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ControlPlanePolicyBypassGuardRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
