
package architecture_evidence

#ResourcePackDistributionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ResourcePackDistributionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
