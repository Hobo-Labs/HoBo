
package architecture_evidence

#IacDriftRefreshFidelityContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#IacDriftRefreshFidelityContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
