
package architecture_evidence

#GenerationSafetyGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationSafetyGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
