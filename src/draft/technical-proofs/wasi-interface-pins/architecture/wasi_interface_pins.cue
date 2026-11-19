
package architecture_evidence

#WasiInterfacePinsEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WasiInterfacePinsRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
