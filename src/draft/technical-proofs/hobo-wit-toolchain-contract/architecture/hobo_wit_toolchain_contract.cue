
package architecture_evidence

#HoboWitToolchainContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboWitToolchainContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
