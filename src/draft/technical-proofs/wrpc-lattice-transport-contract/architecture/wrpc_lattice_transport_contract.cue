
package architecture_evidence

#WrpcLatticeTransportContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WrpcLatticeTransportContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
