// CUE constraints for HOBO-620 orchestrator reconciliation FSM evidence.

package architecture_evidence

#OrchestratorReconciliationFsmEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OrchestratorReconciliationFsmRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
