
package architecture_evidence

#ExampleAppsScopeAcceptanceEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ExampleAppsScopeAcceptanceRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
