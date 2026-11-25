
package architecture_evidence

#BuiltInPolicyEngineContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BuiltInPolicyEngineContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
