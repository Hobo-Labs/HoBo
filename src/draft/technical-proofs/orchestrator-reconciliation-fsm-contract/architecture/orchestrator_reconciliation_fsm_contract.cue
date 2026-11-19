
package architecture_evidence

#OrchestratorReconciliationFsmEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OrchestratorReconciliationFsmRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
