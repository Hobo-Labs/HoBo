
package architecture_evidence

#SettingsProjectLifecycleScopeEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SettingsProjectLifecycleScopeRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
