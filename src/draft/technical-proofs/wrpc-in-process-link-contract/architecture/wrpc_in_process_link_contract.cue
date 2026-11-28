
package architecture_evidence

#WrpcInProcessLinkContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WrpcInProcessLinkContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
