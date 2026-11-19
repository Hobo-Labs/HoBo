
package architecture_evidence

#GatedLiveFixLoopEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GatedLiveFixLoopRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
