
package architecture_evidence

#MultiCloudShopProviderE2eContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MultiCloudShopProviderE2eContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
