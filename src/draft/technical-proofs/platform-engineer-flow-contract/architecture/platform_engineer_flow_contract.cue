
package architecture_evidence

#PlatformEngineerFlowContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PlatformEngineerFlowContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
