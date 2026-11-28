
package architecture_evidence

#RuntimeLocalComponentHostEvidenceKind: "unspecified" | "design-record" | "contract-test"

#RuntimeLocalComponentHostRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
