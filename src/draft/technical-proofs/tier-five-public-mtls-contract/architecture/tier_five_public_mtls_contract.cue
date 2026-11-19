
package architecture_evidence

#TierFivePublicMtlsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TierFivePublicMtlsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
