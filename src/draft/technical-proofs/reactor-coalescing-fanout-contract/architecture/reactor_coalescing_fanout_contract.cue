
package architecture_evidence

#ReactorCoalescingFanoutContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ReactorCoalescingFanoutContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
