
package architecture_evidence

#OpenexperimentRuntimeDataContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#OpenexperimentRuntimeDataContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
