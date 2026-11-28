
package architecture_evidence

#RegistryDependencyConfusionGuardContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RegistryDependencyConfusionGuardContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
