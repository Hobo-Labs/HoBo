
package architecture_evidence

#ReplayLiveEquivalencePocEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ReplayLiveEquivalencePocRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
