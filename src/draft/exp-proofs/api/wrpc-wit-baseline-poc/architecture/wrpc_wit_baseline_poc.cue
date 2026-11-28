
package architecture_evidence

#WrpcWitBaselinePocEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WrpcWitBaselinePocRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
