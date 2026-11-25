
package architecture_evidence

#WitComponentModelRuntimeMembraneEvidenceKind: "unspecified" | "design-record" | "contract-test"

#WitComponentModelRuntimeMembraneRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
