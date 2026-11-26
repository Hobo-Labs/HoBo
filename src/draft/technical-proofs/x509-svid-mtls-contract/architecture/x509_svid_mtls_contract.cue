// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#X509SvidMtlsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#X509SvidMtlsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

