
package architecture_evidence

#BuiltInFlagStoreContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BuiltInFlagStoreContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
