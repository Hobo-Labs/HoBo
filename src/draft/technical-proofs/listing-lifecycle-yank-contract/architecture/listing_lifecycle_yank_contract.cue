
package architecture_evidence

#ListingLifecycleYankContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ListingLifecycleYankContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
