
package architecture_evidence

#PersonaOperatingProfileContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PersonaOperatingProfileContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
