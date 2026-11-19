
package architecture_evidence

#SearchExtensionPackagesContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SearchExtensionPackagesContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
