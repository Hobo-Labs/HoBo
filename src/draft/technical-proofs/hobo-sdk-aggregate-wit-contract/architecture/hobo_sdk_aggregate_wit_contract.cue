
package architecture_evidence

#HoboSdkAggregateWitContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboSdkAggregateWitContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
