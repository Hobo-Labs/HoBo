
package architecture_evidence

#EventBodyUpcasterGateEvidenceKind: "unspecified" | "design-record" | "contract-test"

#EventBodyUpcasterGateRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
