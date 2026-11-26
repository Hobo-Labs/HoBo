// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ConnectorRuntimeBrokerContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ConnectorRuntimeBrokerContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

