
package architecture_evidence

#DenyCeilingAlgebraPocEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DenyCeilingAlgebraPocRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
