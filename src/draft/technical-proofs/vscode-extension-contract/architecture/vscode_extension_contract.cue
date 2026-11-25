
package architecture_evidence

#VscodeExtensionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#VscodeExtensionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
