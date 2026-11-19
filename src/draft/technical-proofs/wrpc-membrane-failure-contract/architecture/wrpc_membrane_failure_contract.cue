
package architecture_evidence

#WrpcMembraneFailureContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WrpcMembraneFailureContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
