
package architecture_evidence

#ProviderLocalZeroInfraEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderLocalZeroInfraRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
