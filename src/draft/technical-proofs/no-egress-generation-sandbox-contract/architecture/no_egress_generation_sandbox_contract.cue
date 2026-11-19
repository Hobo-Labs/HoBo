
package architecture_evidence

#NoEgressGenerationSandboxContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#NoEgressGenerationSandboxContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
