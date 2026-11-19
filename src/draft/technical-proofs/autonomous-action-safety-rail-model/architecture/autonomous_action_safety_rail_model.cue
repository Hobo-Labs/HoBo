
package architecture_evidence

#AutonomousActionSafetyRailModelEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AutonomousActionSafetyRailModelRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
