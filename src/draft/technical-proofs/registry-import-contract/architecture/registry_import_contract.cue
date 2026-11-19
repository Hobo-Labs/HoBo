
package architecture_evidence

#RegistryImportContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RegistryImportContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
