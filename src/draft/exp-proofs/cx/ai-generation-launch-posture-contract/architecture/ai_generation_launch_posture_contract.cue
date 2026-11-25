
package architecture_evidence

#AiGenerationLaunchPostureContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AiGenerationLaunchPostureContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
