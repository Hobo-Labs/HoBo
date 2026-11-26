// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#DenyCeilingAlgebraPocEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DenyCeilingAlgebraPocRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

