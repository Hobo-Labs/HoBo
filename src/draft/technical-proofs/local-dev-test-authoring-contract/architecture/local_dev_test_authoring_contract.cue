
package architecture_evidence

#LocalDevTestAuthoringContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#LocalDevTestAuthoringContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
