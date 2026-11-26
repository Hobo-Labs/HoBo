// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#GoNoGoDecisionRecordEvidenceKind: "unspecified" | "design-record" | "contract-test" | "risk-exception-policy"

#GoNoGoDecisionRecordContractRecord: {
	issue:                 string & !=""
	gate:                  "beta" | "release-candidate" | "ga"
	decision:              "go" | "conditional-go" | "no-go"
	approver_role:         string & !=""
	evidence_links:        [...string]
	blocker_deltas:        [...string]
	accepted_risks:        [...string]
	expiry_or_revisit_date: string & !=""
}
