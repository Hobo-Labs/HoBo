
package architecture_evidence

#DogfoodYardAcceptanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#DogfoodYardAcceptanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
