
package architecture_evidence

#SignedOfflineBundleContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SignedOfflineBundleContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
