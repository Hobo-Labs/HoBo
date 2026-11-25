
package architecture_evidence

#UsageInferredPermissionsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#UsageInferredPermissionsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
