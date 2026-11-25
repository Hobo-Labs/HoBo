
package architecture_evidence

#ControlPlaneActionTaxonomyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ControlPlaneActionTaxonomyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
