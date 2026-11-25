
package architecture_evidence

#RunInspectorProjectionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RunInspectorProjectionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
